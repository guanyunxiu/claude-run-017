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
   */
  async maybeSnapshot(force = false): Promise<boolean> {
    const due = force || Date.now() - this.lastSnapshot >= this.snapshotMs;
    if (!due) return false;
    if (this.buffer.length > 0) {
      await this.flushUpdates();
    }
    if (!this.hasEverBeenPersisted) {
      // Nothing meaningful has ever happened yet; retry later.
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
      await this.prisma.documentUpdate.deleteMany({
        where: {
          fileId: this.documentId,
          id: { lte: BigInt(upToId) },
        },
      });
    }
    if (previous) {
      try {
        await this.storage.deleteSnapshot(previous.s3Key);
      } catch {
        // best effort - newest snapshot is what matters
      }
      await this.prisma.fileSnapshot.deleteMany({ where: { id: previous.id } });
    }

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
    return (
      this.buffer.length > 0 &&
      now - this.lastSnapshot >= this.snapshotMs
    );
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
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly presence: PresenceService,
    config: ConfigService,
  ) {
    this.flushMs = config.get<number>('PERSIST_FLUSH_MS', 5000);
    this.snapshotMs = config.get<number>('SNAPSHOT_INTERVAL_MS', 60000);
    this.ttlMs = config.get<number>('ROOM_TTL_MS', 60000);
    this.timer = setInterval(() => {
      void this.tick();
    }, Math.min(this.flushMs, 1000));
    // Do not keep the process alive solely for the interval.
    this.timer.unref?.();
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

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      try {
        if (room.shouldFlush(now)) {
          await room.flushUpdates();
        }
        if (room.shouldSnapshot(now)) {
          await room.maybeSnapshot();
        }
        if (room.isIdle(this.ttlMs)) {
          await this.evict(id);
        }
      } catch (err) {
        this.logger.error(`Tick failed for ${id}: ${(err as Error).message}`);
      }
    }
  }

  private async evict(id: string): Promise<void> {
    const room = this.rooms.get(id);
    if (!room) return;
    try {
      await room.flushUpdates();
      await room.maybeSnapshot(true);
      room.doc.destroy();
      this.logger.log(`Evicted idle room ${id}`);
    } catch (err) {
      this.logger.error(`Eviction failed for ${id}: ${(err as Error).message}`);
    } finally {
      this.rooms.delete(id);
    }
  }

  async flushAll(): Promise<void> {
    for (const [id] of this.rooms) {
      await this.evict(id);
    }
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.flushAll();
  }
}
