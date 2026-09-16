import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { ConfigService } from '@nestjs/config';
import type { WebSocket } from 'ws';
import { PrismaService } from '../common/prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { PresenceService, PresenceUser } from './presence.service';
import {
  buildAwarenessUpdate,
  buildSyncStep1Response,
  buildSyncUpdateMessage,
} from './collab.protocol';
import { CollaborationBus } from './bus/collaboration-bus';
import { COLLAB_BUS } from './bus/collaboration-bus.provider';

export type ProjectRole = 'owner' | 'editor' | 'viewer';

export interface RoomConnection {
  userId: string;
  name: string;
  color: string;
  role: ProjectRole;
  /** Yjs awareness client ids this websocket opened in this room */
  docClientIds: Set<number>;
}

interface BufferEntry {
  update: Uint8Array;
  size: number;
  /**
   * Where the update originated. `local` entries were produced by a socket on
   * THIS instance and must survive follower/leader churn until the leader
   * confirms them durable (they are the safety net for no-leader windows and
   * failed/delayed bus delivery). `bus` entries arrived from another instance
   * and are buffered only while this room is the leader so it can flush the
   * converged document.
   */
  origin: 'local' | 'bus';
}

/**
 * True when `remoteVector` contains every clock that `localVector` does.
 * Yjs state vectors are Map<clientId, clock>; a document at `remoteVector`
 * therefore already includes every update that produced `localVector`.
 */
function stateVectorCovers(
  localVector: Map<number, number>,
  remoteVector: Uint8Array,
): boolean {
  const remote = Y.decodeStateVector(remoteVector) as Map<number, number>;
  for (const [clientId, clock] of localVector) {
    if ((remote.get(clientId) ?? 0) < clock) return false;
  }
  return true;
}

/** Updates replayed from storage on room load: neither broadcast nor persisted. */
const ROOM_LOAD_ORIGIN = Symbol('room-load-origin');
/** Updates received from another backend instance through the bus. */
const BUS_ORIGIN = Symbol('bus-origin');

/** A websocket transaction origin (our internal origins are symbols). */
function isLocalSocketOrigin(origin: unknown): origin is WebSocket {
  return typeof origin === 'object' && origin !== null;
}

/**
 * One Room = one Y.Doc shared by every websocket connected to a documentId on
 * THIS instance. When the Redis bus is enabled, updates/awareness are mirrored
 * to peer instances and only the elected persistence leader writes to
 * Postgres/S3 for a given document.
 */
export class Room {
  private readonly logger: Logger;
  readonly doc = new Y.Doc();
  readonly awareness: Awareness;
  /** webSocket -> connection metadata */
  readonly connections = new Map<WebSocket, RoomConnection>();
  /** awareness clientId -> owning websocket, needed on disconnect */
  readonly clientIdToSocket = new Map<number, WebSocket>();

  private buffer: BufferEntry[] = [];
  private bufferBytes = 0;
  /**
   * doc updates captured locally but not yet acknowledged as delivered to
   * another backend over the bus. They are also in `buffer`; this queue
   * exists to retry Redis publishes in order.
   */
  private pendingPublishes: Uint8Array[] = [];
  private publishing = false;
  private lastFlush = Date.now();
  private lastSnapshot = Date.now();
  private lastActivity = Date.now();
  private flushing = false;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  /** highest DocumentUpdate.id already incorporated into this in-memory doc */
  private persistedUpToId: bigint | null = null;
  private hasEverBeenPersisted = false;
  /** Bytes of Postgres updates since the last S3 compaction (snapshot trigger). */
  private bytesAwaitingSnapshot = 0;

  /**
   * True iff this instance currently owns the document's persistence lease.
   * With the in-process (single-instance) bus there is nobody to compete
   * with, so a room leads from birth; under the Redis bus leadership is
   * acquired via tick().
   */
  isLeader: boolean;

  constructor(
    public readonly documentId: string,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly presence: PresenceService,
    private readonly flushMs: number,
    private readonly snapshotMs: number,
    private readonly bus: CollaborationBus,
  ) {
    this.logger = new Logger(`Room:${this.documentId.slice(0, 8)}`);
    this.awareness = new Awareness(this.doc);
    this.isLeader = !bus.enabled;

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const fromStorage = origin === ROOM_LOAD_ORIGIN;
      const fromBus = origin === BUS_ORIGIN;

      // Broadcast to local peers except the originator (a websocket). Storage
      // replay is never echoed; bus-relayed updates go to every local socket.
      if (!fromStorage) {
        const message = buildSyncUpdateMessage(update);
        for (const [socket] of this.connections) {
          if (socket === origin || socket.readyState !== 1) continue;
          socket.send(message);
        }
      }

      if (fromStorage) {
        this.lastActivity = Date.now();
        return;
      }

      // DURABILITY MODEL
      // --------------
      // Every update that advanced this document is buffered locally, no
      // matter whether we currently hold the persistence lease:
      //
      //  - local-origin updates (from a connected socket) are ALWAYS buffered
      //    as 'local'. They cannot be dropped during the no-leader window
      //    (before the first lease is acquired / during a lease handover) nor
      //    when Redis publish fails. The leader will flush them directly; as a
      //    follower they stay until a leader 'persisted' state vector confirms
      //    durability (or this instance wins the lease and flushes itself).
      //  - bus-origin updates are buffered as 'bus' only while we are the
      //    leader, so the single writer can flush the fully converged document
      //    (including edits that originated on other instances). Followers
      //    must not flush those - the originating peer owns their durability.
      this.buffer.push({
        update,
        size: update.byteLength,
        origin: fromBus ? 'bus' : 'local',
      });
      this.bufferBytes += update.byteLength;
      this.lastActivity = Date.now();
    });

    // Server-published awareness field (savedAt timestamps). y-websocket
    // clients ignore fields they do not know about.
    this.awareness.setLocalStateField('server', {
      documentId,
      startedAt: Date.now(),
    });

    this.awareness.on(
      'update',
      (
        change: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changedClients = change.added
          .concat(change.updated)
          .concat(change.removed);
        const message = buildAwarenessUpdate(this.awareness, changedClients);
        const fromLocal = isLocalSocketOrigin(origin);

        // Fan out to local sockets (skip originator for local changes).
        for (const [socket] of this.connections) {
          if (fromLocal && socket === origin) continue;
          if (socket.readyState !== 1) continue;
          socket.send(message);
        }

        // Only mirror local awareness changes to peer backends; bus-received
        // awareness must not be republished (would loop).
        if (fromLocal && this.bus.enabled) {
          // Encode just the awareness payload without the outer frame type.
          void this.bus.publishAwareness(
            this.documentId,
            awarenessPayload(this.awareness, changedClients),
          );
        }

        // Presence ownership: an instance writes/removes Redis presence ONLY
        // for clientIds whose websocket it owns. Remote (bus) awareness and
        // the server's own state are excluded.
        if (fromLocal) {
          void this.syncPresenceFromAwareness(changedClients);
        }
      },
    );
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  isIdle(ttlMs: number): boolean {
    return this.connections.size === 0 && Date.now() - this.lastActivity > ttlMs;
  }

  hasLocalConnections(): boolean {
    return this.connections.size > 0;
  }

  // ---------------------------------------------------------------- load
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadFromStorage();
    await this.loadPromise;
    this.loaded = true;
    this.loadPromise = null;
  }

  private async loadFromStorage(): Promise<void> {
    const snapshot = await this.prisma.fileSnapshot.findFirst({
      where: { fileId: this.documentId },
      orderBy: { version: 'desc' },
    });

    if (snapshot) {
      try {
        const bytes = await this.storage.getSnapshot(snapshot.s3Key);
        Y.applyUpdate(this.doc, bytes, ROOM_LOAD_ORIGIN);
        this.hasEverBeenPersisted = true;
      } catch (err) {
        this.logger.error(
          `Failed to load snapshot ${snapshot.s3Key}: ${(err as Error).message}. Falling back to update log.`,
        );
      }
    }

    const tail = await this.prisma.documentUpdate.findMany({
      where: snapshot
        ? {
            fileId: this.documentId,
            id: { gt: BigInt(snapshot.lastUpdateId) },
          }
        : { fileId: this.documentId },
      orderBy: { id: 'asc' },
    });
    Y.transact(this.doc, () => {
      for (const row of tail) {
        Y.applyUpdate(
          this.doc,
          row.update as unknown as Uint8Array,
          ROOM_LOAD_ORIGIN,
        );
      }
    });
    this.hasEverBeenPersisted = this.hasEverBeenPersisted || tail.length > 0;
    this.persistedUpToId =
      tail.length > 0
        ? tail[tail.length - 1].id
        : snapshot
          ? BigInt(snapshot.lastUpdateId)
          : null;
    this.logger.log(
      `Loaded doc with ${tail.length} tail updates, lastId=${this.persistedUpToId?.toString() ?? 'none'}`,
    );
  }

  // ------------------------------------------------ ingress from websocket
  /**
   * Apply an update from a locally connected client and durably hand it to
   * peer backends. The update is already in the persistence buffer by the
   * time this runs (the doc 'update' listener put it there), so a failed
   * publish never loses it: it stays in `pendingPublishes` and is retried in
   * order on every tick until acknowledged by Redis.
   */
  async applyClientUpdate(update: Uint8Array, origin: WebSocket): Promise<void> {
    Y.applyUpdate(this.doc, update, origin);
    if (this.bus.enabled) {
      this.pendingPublishes.push(update);
      await this.drainPendingPublishes();
    }
  }

  /** Retry any bus publishes that failed previously (in order). */
  async drainPendingPublishes(): Promise<void> {
    if (this.publishing || this.pendingPublishes.length === 0) return;
    this.publishing = true;
    try {
      while (this.pendingPublishes.length > 0) {
        const next = this.pendingPublishes[0];
        await this.bus.publishDocUpdate(this.documentId, next);
        this.pendingPublishes.shift();
      }
    } catch (err) {
      // Keep the remainder queued; the next tick retries.
      this.logger.warn(
        `bus publish failed (${this.pendingPublishes.length} queued): ${(err as Error).message}`,
      );
    } finally {
      this.publishing = false;
    }
  }

  hasPendingPublishes(): boolean {
    return this.pendingPublishes.length > 0;
  }

  // ----------------------------------------------------- awareness ingress
  /** Apply an awareness update from a locally connected client and mirror it. */
  applyClientAwareness(payload: Uint8Array, origin: WebSocket): void {
    // The awareness 'update' listener fans out locally, republishes to the
    // bus (origin is a local socket) and refreshes owned presence entries.
    applyEncodedAwareness(this.awareness, payload, origin);
  }

  /** Remove awareness state for locally owned clients (disconnect). */
  removeLocalClients(clientIds: number[], origin: WebSocket): void {
    // 'update' listener publishes the removal to peers; we then delete ONLY
    // the Redis presence entries owned by this instance.
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      clientIds,
      origin,
    );
    void this.removeLocalPresence(clientIds);
  }

  // ----------------------------------------------------- ingress from bus
  applyBusUpdate(update: Uint8Array): void {
    // Origin = bus marker: broadcast to local sockets, never re-publish.
    // The 'update' listener buffers it as a 'bus' entry while we are leader.
    Y.applyUpdate(this.doc, update, BUS_ORIGIN);
  }

  applyBusAwareness(payload: Uint8Array): void {
    applyEncodedAwareness(this.awareness, payload, BUS_ORIGIN);
  }

  /** A peer asks for this instance's current state (used at startup catch-up). */
  answerSyncStep1(stateVector: Uint8Array, targetInstance: string): void {
    if (!this.bus.enabled) return;
    const update = Y.encodeStateAsUpdate(this.doc, stateVector);
    void this.bus.publishSyncStep2(this.documentId, update, targetInstance);
  }

  applyBusSyncStep2(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, BUS_ORIGIN);
  }

  // ------------------------------------------------------------- persistence
  async flushUpdates(): Promise<number> {
    if (!this.isLeader) return 0;
    if (this.flushing || this.buffer.length === 0) return 0;
    this.flushing = true;
    const entries = this.buffer;
    this.buffer = [];
    this.bufferBytes = 0;

    try {
      const merged =
        entries.length === 1
          ? entries[0].update
          : Y.mergeUpdates(entries.map((e) => e.update));

      const row = await this.prisma.documentUpdate.create({
        data: {
          fileId: this.documentId,
          update: Buffer.from(merged),
          sizeBytes: merged.byteLength,
        },
        select: { id: true },
      });
      this.persistedUpToId = row.id;
      this.hasEverBeenPersisted = true;
      this.bytesAwaitingSnapshot += merged.byteLength;
      this.lastFlush = Date.now();
      this.logger.debug(
        `Flushed ${entries.length} update(s), ${merged.byteLength} bytes`,
      );
      await this.broadcastSavedAt();
      // Tell followers exactly which clocks are now durable so they can drop
      // their local safety buffers. Fire-and-forget is acceptable here: if
      // this publish is lost the follower simply keeps (and, if needed,
      // later re-flushes as the new leader) the redundant updates - no loss.
      if (this.bus.enabled) {
        void this.bus.publishPersisted(
          this.documentId,
          Y.encodeStateVector(this.doc),
        );
      }
      return entries.length;
    } catch (err) {
      // Put entries back for retry on the next tick. Preserve order.
      this.buffer.unshift(...entries);
      this.bufferBytes += entries.reduce((n, e) => n + e.size, 0);
      this.logger.error(`Flush failed: ${(err as Error).message}`);
      throw err;
    } finally {
      this.flushing = false;
    }
  }

  async maybeSnapshot(force = false): Promise<boolean> {
    if (!this.isLeader) return false;
    const due = force || Date.now() - this.lastSnapshot >= this.snapshotMs;
    if (!due) return false;
    if (this.buffer.length > 0) {
      await this.flushUpdates();
    }
    if (this.bytesAwaitingSnapshot === 0) {
      this.lastSnapshot = Date.now();
      return false;
    }

    const state = Y.encodeStateAsUpdate(this.doc);
    const previous = await this.prisma.fileSnapshot.findFirst({
      where: { fileId: this.documentId },
      orderBy: { version: 'desc' },
    });
    const version = previous ? previous.version + 1 : 0;
    const key = this.storage.snapshotKey(this.documentId, version);
    // Upload first: a failure throws before any metadata change and the next
    // attempt retries cleanly with the update log still intact.
    await this.storage.putSnapshot(key, state);

    const upToId = this.persistedUpToId ? Number(this.persistedUpToId) : 0;

    await this.prisma.fileSnapshot.create({
      data: {
        fileId: this.documentId,
        version,
        s3Key: key,
        lastUpdateId: upToId,
        sizeBytes: state.byteLength,
      },
    });

    if (upToId > 0) {
      try {
        await this.prisma.documentUpdate.deleteMany({
          where: {
            fileId: this.documentId,
            id: { lte: BigInt(upToId) },
          },
        });
      } catch (err) {
        // The new snapshot already covers these rows; a pruning failure is
        // harmless and the next snapshot cleans them up.
        this.logger.warn(
          `Snapshot taken but pruning the update tail failed: ${(err as Error).message}`,
        );
      }
    }
    if (previous) {
      try {
        await this.storage.deleteSnapshot(previous.s3Key);
      } catch {
        // best effort - the newest snapshot is what loaders pick
      }
      try {
        await this.prisma.fileSnapshot.deleteMany({ where: { id: previous.id } });
      } catch {
        // an older snapshot row is harmless; loader orders by version desc
      }
    }

    this.bytesAwaitingSnapshot = 0;
    this.lastSnapshot = Date.now();
    this.logger.log(
      `Snapshot v${version} written (${state.byteLength} bytes, upToUpdate=${upToId})`,
    );
    return true;
  }

  shouldFlush(now: number = Date.now()): boolean {
    return (
      this.isLeader &&
      this.buffer.length > 0 &&
      now - this.lastFlush >= this.flushMs
    );
  }

  shouldSnapshot(now: number = Date.now()): boolean {
    return (
      this.isLeader &&
      this.bytesAwaitingSnapshot > 0 &&
      now - this.lastSnapshot >= this.snapshotMs
    );
  }

  /** Unconfirmed local edits a follower room still must not lose. */
  hasUnconfirmedLocalEdits(): boolean {
    return this.buffer.some((e) => e.origin === 'local');
  }

  /** Buffer entries broken down for tests/operations. */
  bufferedOrigins(): Array<'local' | 'bus'> {
    return this.buffer.map((e) => e.origin);
  }

  /**
   * Durability barrier before a leader room is destroyed. Postgres flush is
   * the hard requirement; S3 compaction failure must not block eviction since
   * committed update rows remain reconstructable for the next instance.
   */
  async persistAllForEviction(): Promise<void> {
    if (this.isLeader) {
      // Retry any bus publishes first so peers converge before we stop.
      await this.drainPendingPublishes();
      await this.flushUpdates();
      if (this.bytesAwaitingSnapshot > 0) {
        try {
          await this.maybeSnapshot(true);
        } catch (err) {
          this.logger.warn(
            `Snapshot during eviction failed (updates are safe in Postgres): ${(err as Error).message}`,
          );
        }
      }
      if (this.buffer.length > 0) {
        await this.flushUpdates();
      }
    }
    // A follower with unconfirmed local edits cannot be safely evicted:
    // flushing is the leader's job, and dropping them would lose keystrokes
    // that never reached durable storage. Caller should retry (it will either
    // receive a leader 'persisted' vector or win the lease on a later tick).
  }

  // ------------------------------------------------------------- leadership
  setLeader(leader: boolean): void {
    if (leader && !this.isLeader) {
      this.logger.log('Became persistence leader for this document');
      // We now own the single-writer lease. The buffer already contains
      // every converged update (local edits AND bus-relayed edits received
      // while a follower); force an immediate flush so the takeover closes
      // any durability gap left by a crashed previous leader.
      if (this.buffer.length > 0) this.lastFlush = 0;
    } else if (!leader && this.isLeader) {
      this.logger.warn(
        'Lost persistence leadership; retaining unconfirmed local buffer',
      );
      // IMPORTANT: do NOT clear the buffer here. Another instance now owns
      // the lease, but our own local-origin edits may not have been flushed
      // by the previous (us) leader nor yet confirmed durable. They remain
      // buffered until the new leader's 'persisted' vector confirms them;
      // 'bus' entries belonging to peers are pruned by the same mechanism.
      // If this instance wins the lease back, it flushes them itself.
    }
    this.isLeader = leader;
  }

  /**
   * Called when a leader announces it durably flushed up to `leaderVector`.
   * As a follower we can then release:
   *  - all 'bus' entries (already persisted by definition), and
   *  - every 'local' entry whose clocks are covered by the leader vector.
   * Local entries still outstanding (e.g. published just after the flush)
   * are retained. Entries are causally ordered, so we replay them once into a
   * scratch document and find the coverage cutoff rather than decoding each
   * update independently.
   */
  onLeaderPersisted(leaderVector: Uint8Array): void {
    if (this.isLeader || this.buffer.length === 0) return;
    // Determine how many leading LOCAL entries are already covered by the
    // leader's state vector. We replay local entries in arrival order into a
    // scratch document; once coverage breaks we stop because later entries
    // cannot be covered before the cutoff. 'bus' entries are always dropped
    // here (the leader is the single writer for peers' edits).
    const scratch = new Y.Doc();
    let coveredLocalCount = 0;
    for (const entry of this.buffer) {
      if (entry.origin !== 'local') continue;
      Y.applyUpdate(scratch, entry.update, ROOM_LOAD_ORIGIN);
      const scratchVector = Y.decodeStateVector(
        Y.encodeStateVector(scratch),
      ) as Map<number, number>;
      if (!stateVectorCovers(scratchVector, leaderVector)) break;
      coveredLocalCount++;
    }
    scratch.destroy();

    if (coveredLocalCount === 0) {
      // Only bus entries (if any) can be removed.
      const kept = this.buffer.filter((e) => e.origin === 'local');
      if (kept.length !== this.buffer.length) {
        this.buffer = kept;
        this.bufferBytes = kept.reduce((n, e) => n + e.size, 0);
      }
      return;
    }

    // Drop all bus entries plus the first `coveredLocalCount` local entries.
    let seenLocal = 0;
    const kept = this.buffer.filter((e) => {
      if (e.origin === 'bus') return false;
      seenLocal++;
      return seenLocal > coveredLocalCount;
    });
    if (kept.length !== this.buffer.length) {
      this.buffer = kept;
      this.bufferBytes = kept.reduce((n, e) => n + e.size, 0);
    }
  }

  /** Any buffered updates not yet confirmed durable (follower safety net). */
  hasBufferedUpdates(): boolean {
    return this.buffer.length > 0;
  }

  /**
   * Called by the manager the moment this instance wins leadership. Retained
   * for the takeover flush; the buffer already holds the converged state, so
   * an immediate shouldFlush is scheduled via setLeader(). This enqueues the
   * FULL current document as one update to guarantee capture of any delta a
   * crashed prior leader had applied but not flushed.
   */
  ingestLeadershipCheckpoint(): void {
    // Avoid stacking full-state checkpoints if the buffer already contains
    // every clock: a fresh leader's buffer normally suffices, but if the room
    // was created purely from storage with no buffered traffic yet there is
    // nothing new to persist.
    const full = Y.encodeStateAsUpdate(this.doc);
    this.buffer.push({ update: full, size: full.byteLength, origin: 'bus' });
    this.bufferBytes += full.byteLength;
    this.lastFlush = 0; // make shouldFlush() due immediately
  }

  // --------------------------------------------------------------- presence
  private async syncPresenceFromAwareness(clientIds: number[]): Promise<void> {
    const states = this.awareness.getStates();
    const pending: Array<Promise<void>> = [];
    for (const clientId of clientIds) {
      // Only touch presence for clients owned by a local socket.
      if (!this.clientIdToSocket.has(clientId)) continue;
      const state = states.get(clientId);
      if (!state) continue;
      const user = state.user as
        | { id: string; name: string; color: string }
        | undefined;
      if (!user) continue;
      const entry: PresenceUser = {
        clientId,
        userId: user.id,
        name: user.name,
        color: user.color,
        cursor: state.cursor ?? state['y-monaco'] ?? null,
        lastSeen: Date.now(),
      };
      pending.push(this.presence.heartbeat(this.documentId, entry));
    }
    await Promise.all(pending);
  }

  async removeLocalPresence(clientIds: number[]): Promise<void> {
    await Promise.all(
      clientIds.map((id) => this.presence.remove(this.documentId, id)),
    );
  }

  async broadcastSavedAt(): Promise<void> {
    this.awareness.setLocalStateField('server', {
      documentId: this.documentId,
      savedAt: Date.now(),
    });
  }

  // Test/operational helpers
  getBufferedCount(): number {
    return this.buffer.length;
  }

  /** Encode this room's current awareness for a set of clients (no outer frame). */
  encodeAwareness(clientIds: number[]): Uint8Array {
    return awarenessPayload(this.awareness, clientIds);
  }

  encodeSyncStep1Response(clientStateVector: Uint8Array): Uint8Array {
    return buildSyncStep1Response(this.doc, clientStateVector);
  }
}

// ---------------------------------------------------------------------------
// Awareness encoding helpers. Kept module-private so the gateway and room use
// identical, frame-compatible payloads with y-protocols.
// ---------------------------------------------------------------------------
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';

function awarenessPayload(aw: Awareness, clientIds: number[]): Uint8Array {
  return awarenessProtocol.encodeAwarenessUpdate(aw, clientIds);
}

function applyEncodedAwareness(
  aw: Awareness,
  payload: Uint8Array,
  origin: unknown,
): void {
  awarenessProtocol.applyAwarenessUpdate(aw, payload, origin);
}

@Injectable()
export class RoomManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomManager.name);
  private readonly rooms = new Map<string, Room>();
  private readonly flushMs: number;
  private readonly snapshotMs: number;
  private readonly ttlMs: number;
  private readonly leaseMs: number;
  private readonly timer: NodeJS.Timeout | null;
  private readonly bus: CollaborationBus;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly presence: PresenceService,
    config: ConfigService,
    @Inject(COLLAB_BUS) bus: CollaborationBus,
  ) {
    this.flushMs = config.get<number>('PERSIST_FLUSH_MS', 5000);
    this.snapshotMs = config.get<number>('SNAPSHOT_INTERVAL_MS', 60000);
    this.ttlMs = config.get<number>('ROOM_TTL_MS', 60000);
    // Renew well within the TTL so a leader hiccup shorter than the interval
    // does not hand the lease away.
    this.leaseMs = config.get<number>(
      'BUS_LEASE_MS',
      Math.max(this.flushMs * 2, 10_000),
    );
    this.bus = bus;
    this.bus.attachHandlers({
      onDocUpdate: (fileId, update) => {
        this.rooms.get(fileId)?.applyBusUpdate(update);
      },
      onAwareness: (fileId, payload) => {
        this.rooms.get(fileId)?.applyBusAwareness(payload);
      },
      onSyncStep1: (fileId, stateVector, fromInstance) => {
        this.rooms.get(fileId)?.answerSyncStep1(stateVector, fromInstance);
      },
      onSyncStep2: (fileId, update) => {
        this.rooms.get(fileId)?.applyBusSyncStep2(update);
      },
      onPersisted: (fileId, stateVector) => {
        this.rooms.get(fileId)?.onLeaderPersisted(stateVector);
      },
    });

    const autoPersist = config.get<boolean>('COLLAB_AUTO_PERSIST', true);
    if (autoPersist) {
      this.timer = setInterval(() => {
        void this.tick();
      }, Math.min(this.flushMs, 1000));
      this.timer.unref?.();
    } else {
      this.timer = null;
    }
  }

  async onModuleInit(): Promise<void> {
    await this.bus.start();
  }

  get instanceId(): string {
    return this.bus.instanceId;
  }

  async start(): Promise<void> {
    await this.bus.start();
  }

  async getOrCreate(documentId: string): Promise<Room> {
    let room = this.rooms.get(documentId);
    if (!room) {
      room = new Room(
        documentId,
        this.prisma,
        this.storage,
        this.presence,
        this.flushMs,
        this.snapshotMs,
        this.bus,
      );
      this.rooms.set(documentId, room);
      if (this.bus.enabled) {
        await this.bus.subscribe(documentId);
        // Load durable state synchronously (needed before serving reads);
        // peer catch-up runs in the background because both sides of a new
        // document can race to create their rooms at the same instant.
        await room.ensureLoaded();
        void this.catchUpFromPeers(documentId);
      } else {
        await room.ensureLoaded();
      }
    }
    return room;
  }

  /**
   * Ask peer instances for their current state. A brand-new follower can join
   * a document before the leader's room exists, in which case the very first
   * sync-step1 has nobody to answer. Retry a few times with a short delay so
   * the handshake completes regardless of startup ordering, and also cover
   * late-joining peers. A state vector of "empty" requests the full state;
   * peers answer with a targeted sync-step2 over the bus.
   */
  private async catchUpFromPeers(documentId: string): Promise<void> {
    if (!this.bus.enabled) return;
    const emptyVector = Y.encodeStateVector(new Y.Doc());
    const delays = [0, 100, 350, 800];
    for (const delay of delays) {
      await new Promise((r) => setTimeout(r, delay));
      await this.bus.publishSyncStep1(documentId, emptyVector);
    }
  }

  get(documentId: string): Room | undefined {
    return this.rooms.get(documentId);
  }

  roomCount(): number {
    return this.rooms.size;
  }

  /**
   * Attempt to acquire the persistence lease for a document right after the
   * first client connects. This collapses the no-leader window to near zero
   * instead of waiting up to one tick interval; only one instance wins.
   */
  async tryBecomeLeader(documentId: string): Promise<void> {
    if (!this.bus.enabled) return;
    const room = this.rooms.get(documentId);
    if (!room || room.isLeader) return;
    try {
      const acquired = await this.bus.acquireLease(documentId, this.leaseMs);
      if (acquired) {
        room.setLeader(true);
        room.ingestLeadershipCheckpoint();
      }
    } catch (err) {
      this.logger.warn(
        `Immediate lease campaign failed for ${documentId}: ${(err as Error).message}`,
      );
    }
  }

  /** Test hook: run exactly one persistence + leadership + eviction pass. */
  async runIdleSweepForTest(): Promise<void> {
    await this.tick();
  }
  resetRetryCooldownForTest(id?: string): void {
    if (id) this.evictionRetryAt.delete(id);
    else this.evictionRetryAt.clear();
  }

  private readonly evictionRetryAt = new Map<string, number>();
  private static readonly EVICTION_RETRY_DELAY_MS = 5_000;

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      // ---------------- leadership lease ----------------
      // With the in-process bus there is only one instance, so every room is
      // leader from birth and no lease negotiation runs (phase-1 behaviour).
      try {
        // Retry bus publishes that previously failed before anything else so
        // peers converge even through transient Redis outages.
        if (this.bus.enabled) {
          await room.drainPendingPublishes();
        }
        if (this.bus.enabled) {
          if (room.isLeader) {
            const renewed = await this.bus.renewLease(id, this.leaseMs);
            if (!renewed) room.setLeader(false);
          }
          if (!room.isLeader) {
            // Only campaign for documents that matter locally. Idle, empty
            // rooms are handled by eviction below and do not need a leader.
            if (room.hasLocalConnections() || room.hasBufferedUpdates()) {
              const acquired = await this.bus.acquireLease(id, this.leaseMs);
              if (acquired) {
                room.setLeader(true);
                // Capture any updates a crashed previous leader had in memory
                // but never flushed. One full-state row is flushed next tick.
                room.ingestLeadershipCheckpoint();
              }
            }
          }
        }
      } catch (err) {
        this.logger.error(
          `Lease maintenance failed for ${id}: ${(err as Error).message}`,
        );
      }

      // ---------------- durability (leader only) ----------------
      try {
        if (room.shouldFlush(now)) {
          await room.flushUpdates();
        }
        if (room.shouldSnapshot(now)) {
          await room.maybeSnapshot();
        }
      } catch (err) {
        this.logger.error(
          `Persistence tick failed for ${id}: ${(err as Error).message}`,
        );
      }

      // ---------------- idle eviction ----------------
      try {
        if (!room.isIdle(this.ttlMs)) continue;
        const retryAt = this.evictionRetryAt.get(id);
        if (retryAt !== undefined && now < retryAt) continue;

        // A follower holding local edits the leader has not yet confirmed
        // durable MUST NOT be evicted (that would drop them). Try to take
        // over and flush ourselves; otherwise wait for the leader's
        // 'persisted' vector or a later lease win.
        if (
          this.bus.enabled &&
          !room.isLeader &&
          (room.hasUnconfirmedLocalEdits() || room.hasPendingPublishes())
        ) {
          const acquired = await this.bus.acquireLease(id, this.leaseMs);
          if (acquired) {
            room.setLeader(true);
            room.ingestLeadershipCheckpoint();
            await room.drainPendingPublishes();
            await room.flushUpdates();
          } else {
            this.evictionRetryAt.set(
              id,
              Date.now() + RoomManager.EVICTION_RETRY_DELAY_MS,
            );
            continue;
          }
        }

        await this.evict(id);
      } catch (err) {
        this.logger.error(
          `Eviction failed for ${id}; keeping room in memory to retry: ${(err as Error).message}`,
        );
        this.evictionRetryAt.set(
          id,
          Date.now() + RoomManager.EVICTION_RETRY_DELAY_MS,
        );
      }
    }
  }

  private async evict(id: string): Promise<void> {
    const room = this.rooms.get(id);
    if (!room) return;
    await room.persistAllForEviction();
    if (room.isLeader) {
      await this.bus.releaseLease(id);
      room.setLeader(false);
    }
    if (this.bus.enabled) {
      await this.bus.unsubscribe(id);
    }
    room.doc.destroy();
    this.rooms.delete(id);
    this.evictionRetryAt.delete(id);
    this.logger.log(`Evicted idle room ${id}`);
  }

  async flushAll(): Promise<void> {
    for (const [id] of this.rooms) {
      try {
        await this.evict(id);
      } catch (err) {
        this.logger.error(
          `Shutdown flush failed for ${id}: ${(err as Error).message}`,
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flushAll();
    await this.bus.stop();
  }
}
