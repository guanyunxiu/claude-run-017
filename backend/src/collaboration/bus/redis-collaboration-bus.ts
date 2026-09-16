import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import {
  CollaborationBus,
  decodeBusMessage,
  docChannel,
  encodeBusMessage,
  kickChannel,
  KICK_PATTERN,
  lockKey,
  restoreLockKey,
  type BusMessageHeader,
} from './collaboration-bus';

/*
 * Redis Lua scripts. Keys: 1 = lock key; ARGV: 1 = instanceId, 2 = ttlMs.
 */
const LUA_ACQUIRE = `
if redis.call('exists', KEYS[1]) == 0 or redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2])
else
  return nil
end`;

const LUA_RENEW = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end`;

const LUA_RELEASE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

/**
 * Redis-backed cross-instance bus.
 *
 * Two connections are used because a connection in SUBSCRIBE mode can only
 * run subscribe-related commands: `pub` does lock/EVAL/publish, `sub` only
 * listens. Subscriptions are ref-counted so a single SUBSCRIBE is issued per
 * document regardless of how many rooms reference it.
 */
export class RedisCollaborationBus extends CollaborationBus {
  readonly instanceId = `be-${process.pid}-${randomUUID().slice(0, 8)}`;
  readonly enabled = true;

  private readonly logger = new Logger(RedisCollaborationBus.name);
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly subscriptions = new Map<string, number>();
  private readonly ownedLocks = new Set<string>();
  private readonly ownedRestoreLocks = new Set<string>();
  private started = false;

  constructor(redis: Redis) {
    super();
    // Dedicated independent connections even though the app already owns one.
    this.pub = redis.duplicate();
    this.sub = redis.duplicate();
    this.sub.on('message', (channel, message) => {
      this.onMessage(channel, Buffer.from(message, 'binary'));
    });
    // Kick events arrive on per-user channels via one pattern subscription.
    this.sub.on('pmessage', (_pattern, channel, message) => {
      this.onKickMessage(channel, Buffer.from(message, 'binary'));
    });
    this.sub.on('error', (err) => {
      this.logger.warn(`bus subscriber error: ${err.message}`);
    });
    this.pub.on('error', (err) => {
      this.logger.warn(`bus publisher error: ${err.message}`);
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // ioredis connects lazily; explicitly wait for the subscriber channel.
    await Promise.all([this.pub.ping(), this.sub.ping()]);
    await this.sub.psubscribe(KICK_PATTERN);
    this.logger.log(`Collaboration bus started as ${this.instanceId}`);
  }

  private onMessage(channel: string, raw: Buffer): void {
    let parsed: ReturnType<typeof decodeBusMessage>;
    try {
      parsed = decodeBusMessage(raw);
    } catch (err) {
      this.logger.warn(`bad bus frame on ${channel}: ${(err as Error).message}`);
      return;
    }
    const { kind, header, payload } = parsed;
    // Never process our own frames back to ourselves (redis delivers to all
    // subscribers including the publisher).
    if (header.i === this.instanceId) return;

    const prefix = 'collab:doc:';
    if (!channel.startsWith(prefix)) return;
    const fileId = channel.slice(prefix.length);

    switch (kind) {
      case 'doc-update':
        this.safeRun((h) => h.onDocUpdate(fileId, payload, header.i));
        break;
      case 'awareness':
        this.safeRun((h) => h.onAwareness(fileId, payload, header.i));
        break;
      case 'sync-step1':
        this.safeRun((h) => h.onSyncStep1(fileId, payload, header.i));
        break;
      case 'sync-step2':
        // Unicast: every instance receives it on the shared channel but only
        // the requested destination applies it.
        if (header.t === this.instanceId) {
          this.safeRun((h) =>
            h.onSyncStep2(fileId, payload, this.instanceId, header.i),
          );
        }
        break;
      case 'persisted':
        this.safeRun((h) => h.onPersisted(fileId, payload, header.i));
        break;
      case 'restore-prepare':
        this.safeRun((h) =>
          h.onRestorePrepare(fileId, header.i, header.rid ?? ''),
        );
        break;
      case 'restore-commit':
        this.safeRun((h) =>
          h.onRestoreCommit(fileId, payload, header.i, header.rid ?? ''),
        );
        break;
      case 'restore-abort':
        this.safeRun((h) =>
          h.onRestoreAbort(fileId, header.i, header.rid ?? ''),
        );
        break;
    }
  }

  private onKickMessage(channel: string, raw: Buffer): void {
    // collab:kick:<userId>; payload is "<instanceId>\n<reason>"
    const prefix = 'collab:kick:';
    if (!channel.startsWith(prefix)) return;
    const userId = channel.slice(prefix.length);
    const text = raw.toString('utf8');
    const sep = text.indexOf('\n');
    const fromInstance = sep === -1 ? text : text.slice(0, sep);
    const reason = sep === -1 ? '' : text.slice(sep + 1);
    if (fromInstance === this.instanceId) return; // ignore our own echo
    if (!this.controlHandlers) return;
    try {
      this.controlHandlers.onKick(userId, reason, fromInstance);
    } catch (err) {
      this.logger.error(`kick handler failed: ${(err as Error).message}`);
    }
  }

  private safeRun(run: (h: import('./collaboration-bus').BusHandlers) => void): void {
    if (!this.h) return;
    try {
      run(this.h);
    } catch (err) {
      this.logger.error(`bus handler failed: ${(err as Error).message}`);
    }
  }

  async subscribe(fileId: string): Promise<void> {
    const channel = docChannel(fileId);
    const count = this.subscriptions.get(channel) ?? 0;
    this.subscriptions.set(channel, count + 1);
    if (count === 0) {
      await this.sub.subscribe(channel);
    }
  }

  async unsubscribe(fileId: string): Promise<void> {
    const channel = docChannel(fileId);
    const count = this.subscriptions.get(channel) ?? 0;
    if (count <= 1) {
      this.subscriptions.delete(channel);
      if (count > 0) await this.sub.unsubscribe(channel);
    } else {
      this.subscriptions.set(channel, count - 1);
    }
  }

  private async publish(
    kind: Parameters<typeof encodeBusMessage>[0],
    fileId: string,
    payload: Uint8Array,
    opts: { target?: string; rid?: string } = {},
  ): Promise<void> {
    const header: BusMessageHeader = {
      i: this.instanceId,
      ...(opts.target ? { t: opts.target } : {}),
      ...(opts.rid ? { rid: opts.rid } : {}),
    };
    await this.pub.publish(
      docChannel(fileId),
      encodeBusMessage(kind, payload, header),
    );
  }

  publishDocUpdate(fileId: string, update: Uint8Array): Promise<void> {
    return this.publish('doc-update', fileId, update);
  }
  publishAwareness(fileId: string, update: Uint8Array): Promise<void> {
    return this.publish('awareness', fileId, update);
  }
  publishSyncStep1(fileId: string, stateVector: Uint8Array): Promise<void> {
    return this.publish('sync-step1', fileId, stateVector);
  }
  publishSyncStep2(fileId: string, update: Uint8Array, targetInstance: string): Promise<void> {
    return this.publish('sync-step2', fileId, update, { target: targetInstance });
  }
  publishPersisted(fileId: string, stateVector: Uint8Array): Promise<void> {
    return this.publish('persisted', fileId, stateVector);
  }

  publishRestorePrepare(fileId: string, rid: string): Promise<void> {
    return this.publish('restore-prepare', fileId, new Uint8Array(0), { rid });
  }
  publishRestoreCommit(
    fileId: string,
    rid: string,
    resetUpdate: Uint8Array,
  ): Promise<void> {
    return this.publish('restore-commit', fileId, resetUpdate, { rid });
  }
  publishRestoreAbort(fileId: string, rid: string): Promise<void> {
    return this.publish('restore-abort', fileId, new Uint8Array(0), { rid });
  }

  async publishKick(userId: string, reason: string): Promise<void> {
    try {
      await this.pub.publish(
        kickChannel(userId),
        `${this.instanceId}\n${reason}`,
      );
    } catch (err) {
      // The local close happens regardless; remote instances may only learn
      // of the removal on the user's next frame via per-frame authz anyway.
      this.logger.warn(`kick publish failed: ${(err as Error).message}`);
    }
  }

  async acquireLease(fileId: string, ttlMs: number): Promise<boolean> {
    const res = (await this.pub.eval(
      LUA_ACQUIRE,
      1,
      lockKey(fileId),
      this.instanceId,
      String(ttlMs),
    )) as string | null;
    const owned = res === 'OK';
    if (owned) this.ownedLocks.add(fileId);
    return owned;
  }

  async renewLease(fileId: string, ttlMs: number): Promise<boolean> {
    if (!this.ownedLocks.has(fileId)) return false;
    const res = (await this.pub.eval(
      LUA_RENEW,
      1,
      lockKey(fileId),
      this.instanceId,
      String(ttlMs),
    )) as number;
    if (res !== 1) {
      // Lease expired or was stolen.
      this.ownedLocks.delete(fileId);
      return false;
    }
    return true;
  }

  async releaseLease(fileId: string): Promise<void> {
    if (!this.ownedLocks.has(fileId)) return;
    this.ownedLocks.delete(fileId);
    try {
      await this.pub.eval(
        LUA_RELEASE,
        1,
        lockKey(fileId),
        this.instanceId,
      );
    } catch (err) {
      this.logger.warn(`lease release failed: ${(err as Error).message}`);
    }
  }

  async acquireRestoreLock(fileId: string, ttlMs: number): Promise<boolean> {
    const res = (await this.pub.eval(
      LUA_ACQUIRE,
      1,
      restoreLockKey(fileId),
      this.instanceId,
      String(ttlMs),
    )) as string | null;
    const owned = res === 'OK';
    if (owned) this.ownedRestoreLocks.add(fileId);
    return owned;
  }

  async releaseRestoreLock(fileId: string): Promise<void> {
    if (!this.ownedRestoreLocks.has(fileId)) return;
    this.ownedRestoreLocks.delete(fileId);
    try {
      await this.pub.eval(
        LUA_RELEASE,
        1,
        restoreLockKey(fileId),
        this.instanceId,
      );
    } catch (err) {
      this.logger.warn(`restore lock release failed: ${(err as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    // Release everything this instance owned so another backend takes over
    // immediately instead of waiting for the TTL to expire.
    const files = [...this.ownedLocks];
    await Promise.all(files.map((f) => this.releaseLease(f)));
    const restores = [...this.ownedRestoreLocks];
    await Promise.all(restores.map((f) => this.releaseRestoreLock(f)));
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
