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
      void fromBus;

      // Broadcast to local peers except the originator (a websocket). Storage
      // replay is never echoed; bus-relayed updates go to every local socket.
      if (!fromStorage) {
        const message = buildSyncUpdateMessage(update);
        for (const [socket] of this.connections) {
          if (socket === origin || socket.readyState !== 1) continue;
          socket.send(message);
        }
      }

      // Single-writer persistence: the leader is the ONLY instance that
      // writes, and it persists every update that advanced its converged
      // document - regardless of whether it originated on a local socket or
      // arrived from another instance via the bus. Followers never write.
      // Bus updates are therefore buffered on the leader (but still not
      // re-published to the bus, so there is no loop and no duplicated rows:
      // the originating follower is by definition a non-leader).
      if (this.isLeader && !fromStorage) {
        this.buffer.push({ update, size: update.byteLength });
        this.bufferBytes += update.byteLength;
      }
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
  /** Apply an update sent by a locally connected client and mirror it to peers. */
  applyClientUpdate(update: Uint8Array, origin: WebSocket): void {
    Y.applyUpdate(this.doc, update, origin);
    if (this.bus.enabled) {
      void this.bus.publishDocUpdate(this.documentId, update);
    }
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
    // Origin = bus marker: broadcast to local sockets, never re-publish and
    // (on the leader) never re-buffer because the originating leader persisted.
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
    const byteCount = this.bufferBytes;
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
        `Flushed ${entries.length} update(s), ${merged.byteLength} bytes (unmerged ${byteCount})`,
      );
      await this.broadcastSavedAt();
      return entries.length;
    } catch (err) {
      // Put entries back for retry on the next tick.
      this.buffer.unshift(...entries);
      this.bufferBytes += byteCount;
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

  /**
   * Durability barrier before a leader room is destroyed. Postgres flush is
   * the hard requirement; S3 compaction failure must not block eviction since
   * committed update rows remain reconstructable for the next instance.
   */
  async persistAllForEviction(): Promise<void> {
    if (this.isLeader) {
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
  }

  // ------------------------------------------------------------- leadership
  setLeader(leader: boolean): void {
    if (leader && !this.isLeader) {
      this.logger.log('Became persistence leader for this document');
    } else if (!leader && this.isLeader) {
      this.logger.warn('Lost persistence leadership; dropping local buffer');
      // Another instance owns the lease now. Discard any unflushed buffer so
      // we cannot double-write; the new leader holds the converged state via
      // the bus (and persisted rows survive regardless).
      this.buffer = [];
      this.bufferBytes = 0;
    }
    this.isLeader = leader;
  }

  /** Any unflushed local edits (only meaningful on the leader). */
  hasBufferedUpdates(): boolean {
    return this.buffer.length > 0;
  }

  /**
   * Called by the manager the moment this instance wins leadership. The room
   * already holds the converged document state (storage load + every update
   * relayed over the bus while it was a follower), but bus-origin updates were
   * deliberately NOT buffered (only the then-leader persisted them). If that
   * previous leader crashed before flushing, its unflushed delta exists only in
   * peer memory. We therefore enqueue the FULL current state for one immediate
   * flush. It is pushed straight into the persistence buffer - never applied
   * to the doc - so it is not broadcast to already-converged clients; Yjs CRDT
   * idempotency makes the redundant content harmless on replay.
   */
  ingestLeadershipCheckpoint(): void {
    const full = Y.encodeStateAsUpdate(this.doc);
    this.buffer.push({ update: full, size: full.byteLength });
    this.bufferBytes += full.byteLength;
    this.lastFlush = 0; // make shouldFlush() due on the next tick
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
