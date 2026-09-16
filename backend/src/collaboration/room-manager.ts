import {
  Injectable,
  Logger,
  OnModuleDestroy,
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

/** Marker origin applied to updates replayed from storage so they are not persisted again. */
const ROOM_LOAD_ORIGIN = Symbol('room-load-origin');

/**
 * One Room = one Y.Doc shared by every websocket connected to a documentId.
 *
 * The Room owns:
 *   - the in-memory Y.Doc (CRDT source of truth while the room is active)
 *   - a server-side Awareness instance (cursors / selections / presence)
 *   - persistence buffers periodically flushed to Postgres and compacted
 *     into S3 snapshots.
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
  /**
   * Bytes of document updates persisted to Postgres since the last S3
   * compaction. A snapshot is due once this is non-zero AND the interval
   * elapsed. We must not key scheduling off `buffer.length`: the tick flushes
   * (and empties) that buffer *before* checking the snapshot condition, which
   * would otherwise starve snapshots for continuously active rooms.
   */
  private bytesAwaitingSnapshot = 0;

  constructor(
    public readonly documentId: string,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly presence: PresenceService,
    private readonly flushMs: number,
    private readonly snapshotMs: number,
  ) {
    this.logger = new Logger(`Room:${this.documentId.slice(0, 8)}`);
    this.awareness = new Awareness(this.doc);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Broadcast to everyone except the originating socket. y-websocket
      // clients treat all SYNC_UPDATE messages the same regardless of sub-type.
      const message = buildSyncUpdateMessage(update);
      for (const [socket] of this.connections) {
        if (socket === origin || socket.readyState !== 1) continue;
        socket.send(message);
      }
      // Never persist updates replayed from storage during room load.
      if (origin !== ROOM_LOAD_ORIGIN) {
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
        originSocket: unknown,
      ) => {
        const changedClients = change.added
          .concat(change.updated)
          .concat(change.removed);
        const message = buildAwarenessUpdate(this.awareness, changedClients);
        for (const [socket] of this.connections) {
          if (socket === originSocket || socket.readyState !== 1) continue;
          socket.send(message);
        }
        void this.syncPresenceFromAwareness();
      },
    );
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  isIdle(ttlMs: number): boolean {
    return this.connections.size === 0 && Date.now() - this.lastActivity > ttlMs;
  }

  /**
   * Load current document state from S3 snapshot + Postgres update tail.
   * Runs once, lazily, when the first connection joins.
   */
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

  /** Apply a client-originating update; emits the doc 'update' event. */
  applyClientUpdate(update: Uint8Array, origin: WebSocket): void {
    Y.applyUpdate(this.doc, update, origin);
  }

  /** y-websocket SYNC_STEP_1 -> response containing missing structural state. */
  encodeSyncStep1Response(clientStateVector: Uint8Array): Uint8Array {
    return buildSyncStep1Response(this.doc, clientStateVector);
  }

  /**
   * Persist buffered updates. Called on a timer and when the room is evicted.
   */
  async flushUpdates(): Promise<number> {
    if (this.flushing || this.buffer.length === 0) return 0;
    this.flushing = true;
    const entries = this.buffer;
    this.buffer = [];
    const byteCount = this.bufferBytes;
    this.bufferBytes = 0;

    try {
      // Merge many small updates into one row to reduce write amplification,
      // while preserving a total-order append log.
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

  /**
   * Compact the active document into a fresh S3 snapshot and prune the update
   * tail. We retain only the newest snapshot per file.
   *
   * Scheduling is based on `bytesAwaitingSnapshot` (Postgres updates accumulated
   * since the previous snapshot), NOT on the in-memory buffer, because the
   * periodic tick flushes that buffer first.
   */
  async maybeSnapshot(force = false): Promise<boolean> {
    const due = force || Date.now() - this.lastSnapshot >= this.snapshotMs;
    if (!due) return false;
    if (this.buffer.length > 0) {
      await this.flushUpdates();
    }
    if (this.bytesAwaitingSnapshot === 0) {
      // Nothing newer than the previous snapshot; retry later.
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
    // Upload first: if this fails we throw before any metadata change and the
    // next attempt retries cleanly with the update log still intact.
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
        // The new snapshot already covers these rows (load reads only
        // id > lastUpdateId), so leaving them behind is harmless; they are
        // pruned by the next snapshot. Do not fail/roll back the snapshot.
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
    return this.buffer.length > 0 && now - this.lastFlush >= this.flushMs;
  }

  shouldSnapshot(now: number = Date.now()): boolean {
    // Due once the interval has elapsed AND there are persisted updates not
    // yet captured by a snapshot. Continuously active rooms must compact too.
    return (
      this.bytesAwaitingSnapshot > 0 &&
      now - this.lastSnapshot >= this.snapshotMs
    );
  }

  /**
   * Durability barrier used before a room is destroyed/evicted.
   *
   * MUST leave no buffered updates only in memory. Postgres flush success is
   * the hard requirement: once committed there, reconnecting clients can
   * reconstruct the document from the update log even if the S3 compaction
   * below fails. The snapshot itself is best-effort here - a failure is
   * logged but does not block eviction (and leaves the committed update rows
   * to be compacted by the next room instance).
   */
  async persistAllForEviction(): Promise<void> {
    // Loop because flushUpdates is not re-entrant-safe across concurrent
    // calls and new edits can theoretically land right before the last flush.
    await this.flushUpdates();
    if (this.bytesAwaitingSnapshot > 0) {
      try {
        await this.maybeSnapshot(true);
      } catch (err) {
        // The committed update rows in Postgres are still the source of truth
        // until a snapshot supersedes them; the next room instance compacts.
        this.logger.warn(
          `Snapshot during eviction failed (updates are safe in Postgres): ${(err as Error).message}`,
        );
      }
    }
    // Final guard: if the snapshot attempt did not throw but also could not
    // compact (should not happen with force), make sure nothing remains only
    // in the in-memory buffer.
    if (this.buffer.length > 0) {
      await this.flushUpdates();
    }
  }

  /**
   * Reflect awareness state into Redis presence. We strip the (potentially
   * large) cursor payload down to a compact JSON entry per client.
   */
  private async syncPresenceFromAwareness(): Promise<void> {
    const states = this.awareness.getStates();
    const pending: Array<Promise<void>> = [];
    for (const [clientId, state] of states) {
      const user = state?.user as
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

  async recordDisconnectInPresence(clientIds: number[]): Promise<void> {
    await Promise.all(
      clientIds.map((id) => this.presence.remove(this.documentId, id)),
    );
  }

  async broadcastSavedAt(): Promise<void> {
    // The server awareness field lets every client update its "saved" indicator
    // without a separate protocol / polling endpoint.
    this.awareness.setLocalStateField('server', {
      documentId: this.documentId,
      savedAt: Date.now(),
    });
  }

  // Test/operational helpers
  getBufferedCount(): number {
    return this.buffer.length;
  }
}

@Injectable()
export class RoomManager implements OnModuleDestroy {
  private readonly logger = new Logger(RoomManager.name);
  private readonly rooms = new Map<string, Room>();
  private readonly flushMs: number;
  private readonly snapshotMs: number;
  private readonly ttlMs: number;
  private readonly timer: NodeJS.Timeout | null;
  /**
   * Rooms whose eviction failed (Postgres/S3 unavailable). They stay in the
   * map with their Y.Doc and unflushed buffer intact and are retried after a
   * cooldown instead of being dropped (which would silently revert the doc).
   */
  private readonly evictionRetryAt = new Map<string, number>();
  private static readonly EVICTION_RETRY_DELAY_MS = 5_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly presence: PresenceService,
    config: ConfigService,
  ) {
    this.flushMs = config.get<number>('PERSIST_FLUSH_MS', 5000);
    this.snapshotMs = config.get<number>('SNAPSHOT_INTERVAL_MS', 60000);
    this.ttlMs = config.get<number>('ROOM_TTL_MS', 60000);
    // Production runs the background persistence loop. Tests disable it
    // (COLLAB_AUTO_PERSIST=false) so timers cannot race the assertions and
    // evict rooms mid-scenario.
    if (config.get<boolean>('COLLAB_AUTO_PERSIST', true)) {
      this.timer = setInterval(() => {
        void this.tick();
      }, Math.min(this.flushMs, 1000));
      // Do not keep the process alive solely for the interval.
      this.timer.unref?.();
    } else {
      this.timer = null;
    }
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
      );
      this.rooms.set(documentId, room);
      await room.ensureLoaded();
    }
    return room;
  }

  get(documentId: string): Room | undefined {
    return this.rooms.get(documentId);
  }

  roomCount(): number {
    return this.rooms.size;
  }

  /** Test hook: run exactly one persistence + eviction pass. */
  async runIdleSweepForTest(): Promise<void> {
    await this.tick();
  }

  /** Test hook: clear eviction retry cooldowns. */
  resetRetryCooldownForTest(id?: string): void {
    if (id) this.evictionRetryAt.delete(id);
    else this.evictionRetryAt.clear();
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      try {
        // Durability runs for every room, busy or idle.
        if (room.shouldFlush(now)) {
          await room.flushUpdates();
        }
        if (room.shouldSnapshot(now)) {
          await room.maybeSnapshot();
        }
      } catch (err) {
        // Persistence is unavailable right now. The buffered updates stay in
        // memory and are retried on the next tick; nothing is discarded.
        this.logger.error(
          `Persistence tick failed for ${id}: ${(err as Error).message}`,
        );
      }

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

  /**
   * Evict an idle room. The in-memory Y.Doc is destroyed and the room is
   * removed from the map ONLY after every buffered update has been durably
   * flushed to Postgres (and compacted into S3). Any failure propagates so
   * the caller keeps the room and retries later - never silently dropping
   * edits and reverting reconnecting clients to an older document.
   */
  private async evict(id: string): Promise<void> {
    const room = this.rooms.get(id);
    if (!room) return;
    await room.persistAllForEviction();
    room.doc.destroy();
    this.rooms.delete(id);
    this.evictionRetryAt.delete(id);
    this.logger.log(`Evicted idle room ${id}`);
  }

  async flushAll(): Promise<void> {
    // Used on graceful shutdown. Best effort per room: log failures but
    // attempt every document; a failed one is simply abandoned with the
    // process (its in-memory edits were rebroadcast and are retried while
    // the process keeps running until shutdown is forced).
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
  }
}
