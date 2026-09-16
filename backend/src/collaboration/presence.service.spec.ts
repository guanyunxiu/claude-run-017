import { PresenceService } from './presence.service';

class FakeRedis {
  private store = new Map<string, Map<string, string>>();
  private expirations = new Map<string, number>();

  async hset(key: string, field: string, value: string) {
    if (!this.store.has(key)) this.store.set(key, new Map());
    this.store.get(key)!.set(field, value);
    return 1;
  }
  async expire(key: string, ttl: number) {
    this.expirations.set(key, ttl);
    return 1;
  }
  async hdel(key: string, ...fields: string[]) {
    const m = this.store.get(key);
    if (!m) return 0;
    let removed = 0;
    for (const f of fields) {
      if (m.delete(f)) removed++;
    }
    return removed;
  }
  async hgetall(key: string) {
    return Object.fromEntries(this.store.get(key) ?? new Map());
  }
  async hlen(key: string) {
    return this.store.get(key)?.size ?? 0;
  }
  async keysDeleted() {
    return 0;
  }
  // Test helpers
  _get(key: string) {
    return this.store.get(key);
  }
  _expiration(key: string) {
    return this.expirations.get(key);
  }
}

describe('PresenceService', () => {
  let redis: FakeRedis;
  let presence: PresenceService;

  beforeEach(() => {
    redis = new FakeRedis();
    presence = new PresenceService(
      redis as never,
      { get: (_k: string, d: number) => d } as never,
    );
  });

  it('stores heartbeats per client and lists them back', async () => {
    await presence.heartbeat('doc1', {
      clientId: 1,
      userId: 'u1',
      name: 'Alice',
      color: '#f00',
      lastSeen: Date.now(),
    });
    await presence.heartbeat('doc1', {
      clientId: 2,
      userId: 'u2',
      name: 'Bob',
      color: '#0f0',
      lastSeen: Date.now(),
    });
    const list = await presence.list('doc1');
    expect(list).toHaveLength(2);
    expect(list.map((u) => u.userId).sort()).toEqual(['u1', 'u2']);
    expect(redis._expiration('presence:doc:doc1')).toBe(30);
  });

  it('removes a client on disconnect', async () => {
    await presence.heartbeat('doc1', {
      clientId: 1,
      userId: 'u1',
      name: 'Alice',
      color: '#f00',
      lastSeen: Date.now(),
    });
    await presence.remove('doc1', 1);
    expect(await presence.list('doc1')).toHaveLength(0);
  });

  it('filters out stale entries beyond the TTL', async () => {
    await presence.heartbeat('doc1', {
      clientId: 1,
      userId: 'u1',
      name: 'Alice',
      color: '#f00',
      lastSeen: Date.now() - 60_000,
    });
    expect(await presence.list('doc1')).toHaveLength(0);
  });

  it('isolates documents', async () => {
    await presence.heartbeat('docA', {
      clientId: 1,
      userId: 'u1',
      name: 'A',
      color: '#000',
      lastSeen: Date.now(),
    });
    expect(await presence.list('docB')).toHaveLength(0);
    expect(await presence.count('docA')).toBe(1);
  });
});
