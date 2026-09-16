import { randomUUID } from 'crypto';
import {
  CollaborationBus,
  decodeBusMessage,
  encodeBusMessage,
  type BusMessageHeader,
  type BusMessageKind,
} from './collaboration-bus';

/**
 * Process-local backplane that emulates the Redis bus semantics (pub/sub with
 * publisher exclusion, per-channel ref counting, single-owner leases with TTL).
 * It lets a test run multiple RoomManager "instances" inside one Node process
 * and verify cross-instance convergence, leader election and failover without
 * needing an actual Redis server.
 */
export class InMemoryCollaborationBus extends CollaborationBus {
  readonly instanceId: string;
  readonly enabled = true;

  private static readonly instances = new Set<InMemoryCollaborationBus>();
  private static readonly channels = new Map<string, Set<InMemoryCollaborationBus>>();
  private static readonly locks = new Map<string, { owner: string; expiresAt: number }>();
  /** userId -> instance ids with an attached control handler */
  private static readonly kickSubscribers = new Set<InMemoryCollaborationBus>();

  private listeners = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    super();
    this.instanceId = `mem-${randomUUID().slice(0, 8)}`;
    this.now = now;
    InMemoryCollaborationBus.instances.add(this);
  }

  async start(): Promise<void> {
    InMemoryCollaborationBus.kickSubscribers.add(this);
  }

  private emit(channel: string, raw: Buffer, sender: InMemoryCollaborationBus) {
    for (const peer of InMemoryCollaborationBus.channels.get(channel) ?? []) {
      if (peer === sender) continue; // publisher never receives its own frame
      peer.dispatchRaw(channel, raw);
    }
  }

  private dispatchRaw(channel: string, raw: Buffer) {
    const { kind, header, payload } = decodeBusMessage(raw);
    this.route(channel, kind, payload, header);
  }

  async subscribe(fileId: string): Promise<void> {
    const channel = `collab:doc:${fileId}`;
    const count = this.listeners.get(channel) ?? 0;
    this.listeners.set(channel, count + 1);
    if (count === 0) {
      let set = InMemoryCollaborationBus.channels.get(channel);
      if (!set) {
        set = new Set();
        InMemoryCollaborationBus.channels.set(channel, set);
      }
      set.add(this);
    }
  }

  private route(
    channel: string,
    kind: BusMessageKind,
    payload: Uint8Array,
    header: BusMessageHeader,
  ) {
    const fileId = channel.replace(/^collab:doc:/, '');
    if (!this.h) return;
    if (kind === 'doc-update') this.h.onDocUpdate(fileId, payload, header.i);
    else if (kind === 'awareness') this.h.onAwareness(fileId, payload, header.i);
    else if (kind === 'sync-step1')
      this.h.onSyncStep1(fileId, payload, header.i);
    else if (kind === 'sync-step2' && header.t === this.instanceId)
      this.h.onSyncStep2(fileId, payload, this.instanceId, header.i);
    else if (kind === 'persisted')
      this.h.onPersisted(fileId, payload, header.i);
    else if (kind === 'restore-prepare')
      this.h.onRestorePrepare(fileId, header.i, header.rid ?? '');
    else if (kind === 'restore-commit')
      this.h.onRestoreCommit(fileId, payload, header.i, header.rid ?? '');
    else if (kind === 'restore-abort')
      this.h.onRestoreAbort(fileId, header.i, header.rid ?? '');
  }

  async unsubscribe(fileId: string): Promise<void> {
    const channel = `collab:doc:${fileId}`;
    const count = this.listeners.get(channel) ?? 0;
    if (count <= 1) {
      this.listeners.delete(channel);
      InMemoryCollaborationBus.channels.get(channel)?.delete(this);
    } else {
      this.listeners.set(channel, count - 1);
    }
  }

  private send(fileId: string, raw: Buffer): Promise<void> {
    this.emit(`collab:doc:${fileId}`, raw, this);
    return Promise.resolve();
  }

  publishDocUpdate(fileId: string, update: Uint8Array): Promise<void> {
    return this.send(
      fileId,
      this.frame('doc-update', update, {}),
    );
  }
  publishAwareness(fileId: string, update: Uint8Array): Promise<void> {
    return this.send(fileId, this.frame('awareness', update, {}));
  }
  publishSyncStep1(fileId: string, sv: Uint8Array): Promise<void> {
    return this.send(fileId, this.frame('sync-step1', sv, {}));
  }
  publishSyncStep2(fileId: string, update: Uint8Array, target: string): Promise<void> {
    return this.send(fileId, this.frame('sync-step2', update, { t: target }));
  }
  publishPersisted(fileId: string, stateVector: Uint8Array): Promise<void> {
    return this.send(fileId, this.frame('persisted', stateVector, {}));
  }
  publishRestorePrepare(fileId: string, rid: string): Promise<void> {
    return this.send(fileId, this.frame('restore-prepare', new Uint8Array(0), { rid }));
  }
  publishRestoreCommit(fileId: string, rid: string, update: Uint8Array): Promise<void> {
    return this.send(fileId, this.frame('restore-commit', update, { rid }));
  }
  publishRestoreAbort(fileId: string, rid: string): Promise<void> {
    return this.send(fileId, this.frame('restore-abort', new Uint8Array(0), { rid }));
  }
  async acquireRestoreLock(fileId: string, ttlMs: number): Promise<boolean> {
    const key = `collab:restore:doc:${fileId}`;
    const lock = InMemoryCollaborationBus.locks.get(key);
    const now = this.now();
    if (!lock || lock.expiresAt <= now || lock.owner === this.instanceId) {
      InMemoryCollaborationBus.locks.set(key, {
        owner: this.instanceId,
        expiresAt: now + ttlMs,
      });
      return true;
    }
    return false;
  }
  async releaseRestoreLock(fileId: string): Promise<void> {
    const key = `collab:restore:doc:${fileId}`;
    if (InMemoryCollaborationBus.locks.get(key)?.owner === this.instanceId) {
      InMemoryCollaborationBus.locks.delete(key);
    }
  }

  async publishKick(userId: string, reason: string): Promise<void> {
    // Redis delivers to ALL subscribers except via instance-id filtering;
    // the local kicker handles its own sockets directly (it does not even
    // subscribe), so deliver only to OTHER instances here.
    for (const peer of InMemoryCollaborationBus.kickSubscribers) {
      if (peer === this) continue;
      peer.controlHandlers?.onKick(userId, reason, this.instanceId);
    }
  }

  private frame(kind: BusMessageKind, payload: Uint8Array, extra: { t?: string; rid?: string }): Buffer {
    return encodeBusMessage(kind, payload, { i: this.instanceId, ...extra });
  }

  async acquireLease(fileId: string, ttlMs: number): Promise<boolean> {
    const key = `collab:lock:doc:${fileId}`;
    const lock = InMemoryCollaborationBus.locks.get(key);
    const now = this.now();
    if (!lock || lock.expiresAt <= now || lock.owner === this.instanceId) {
      InMemoryCollaborationBus.locks.set(key, {
        owner: this.instanceId,
        expiresAt: now + ttlMs,
      });
      return true;
    }
    return false;
  }

  async renewLease(fileId: string, ttlMs: number): Promise<boolean> {
    const key = `collab:lock:doc:${fileId}`;
    const lock = InMemoryCollaborationBus.locks.get(key);
    const now = this.now();
    if (lock?.owner === this.instanceId) {
      lock.expiresAt = now + ttlMs;
      return true;
    }
    return false;
  }

  async releaseLease(fileId: string): Promise<void> {
    const key = `collab:lock:doc:${fileId}`;
    if (InMemoryCollaborationBus.locks.get(key)?.owner === this.instanceId) {
      InMemoryCollaborationBus.locks.delete(key);
    }
  }

  async stop(): Promise<void> {
    InMemoryCollaborationBus.instances.delete(this);
    InMemoryCollaborationBus.kickSubscribers.delete(this);
    for (const [channel, peers] of InMemoryCollaborationBus.channels) {
      peers.delete(this);
      if (peers.size === 0) InMemoryCollaborationBus.channels.delete(channel);
    }
  }

  // Test helpers ----------------------------------------------------------
  static reset(): void {
    InMemoryCollaborationBus.instances.clear();
    InMemoryCollaborationBus.channels.clear();
    InMemoryCollaborationBus.locks.clear();
    InMemoryCollaborationBus.kickSubscribers.clear();
  }

  static expireLocksForTest(): void {
    for (const lock of InMemoryCollaborationBus.locks.values()) {
      lock.expiresAt = 0;
    }
  }
}
