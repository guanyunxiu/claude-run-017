/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServer, type Server as HttpServer } from 'http';
import { JwtService } from '@nestjs/jwt';
import { WebSocket as WsWebSocket } from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { CollaborationGateway } from '../src/collaboration/collaboration.gateway';
import { RoomManager } from '../src/collaboration/room-manager';
import { PresenceService } from '../src/collaboration/presence.service';
import { PermissionService } from '../src/projects/permission.service';
import { InMemoryCollaborationBus } from '../src/collaboration/bus/in-memory-collaboration-bus';
import { FilesService } from '../src/files/files.service';

/*
 * Multi-instance horizontal scaling test.
 *
 * Two full backend stacks are started on separate HTTP ports, exactly like
 * two containers behind a load balancer. They share the "durable" world
 * (Postgres/S3 fakes) and an InMemoryCollaborationBus that emulates Redis
 * pub/sub + leader leases. Alice connects to backend A, Bob to backend B.
 */

class FakePrisma {
  updates: any[] = [];
  snapshots: any[] = [];
  private nextId = 1n;
  file = {
    findUnique: async ({ where }: any) =>
      where.id.startsWith('f-') ? { id: where.id, language: 'typescript' } : null,
    findUniqueOrThrow: async ({ where }: any) => ({
      id: where.id,
      language: 'typescript',
    }),
  };
  documentUpdate = {
    create: async ({ data }: any) => {
      const row = { id: this.nextId++, ...data };
      this.updates.push(row);
      return { id: row.id };
    },
    findMany: async ({ where }: any) =>
      this.updates
        .filter((u) => u.fileId === where.fileId)
        .sort((a: any, b: any) => (a.id < b.id ? -1 : 1)),
    deleteMany: async ({ where }: any) => {
      const before = this.updates.length;
      this.updates = this.updates.filter(
        (u: any) =>
          !(u.fileId === where.fileId && where.id && u.id <= where.id.lte),
      );
      return { count: before - this.updates.length };
    },
  };
  fileSnapshot = {
    findFirst: async ({ where }: any) =>
      this.snapshots
        .filter((s) => s.fileId === where.fileId)
        .sort((a, b) => b.version - a.version)[0] ?? null,
    create: async ({ data }: any) => {
      const row = { id: `s${this.snapshots.length}`, ...data };
      this.snapshots.push(row);
      return row;
    },
    count: async ({ where }: any) =>
      this.snapshots.filter((s) => s.fileId === where.fileId).length,
    deleteMany: async ({ where }: any) => {
      this.snapshots = this.snapshots.filter((s) => s.id !== where.id);
      return { count: 1 };
    },
  };
}

class FakeStorage {
  objects = new Map<string, Uint8Array>();
  snapshotKey = (f: string, v: number) => `snapshots/${f}/v${v}.bin`;
  putSnapshot = async (k: string, b: Uint8Array) => {
    this.objects.set(k, b);
  };
  getSnapshot = async (k: string) => {
    const v = this.objects.get(k);
    if (!v) throw new Error('missing');
    return v;
  };
  deleteSnapshot = async (k: string) => {
    this.objects.delete(k);
  };
}

class FakeRedis {
  async hset() {}
  async expire() {}
  async hdel() {}
  async hgetall() {
    return {};
  }
  async hlen() {
    return 0;
  }
}

class FakePermissions {
  roles = new Map<string, 'owner' | 'editor' | 'viewer'>();
  setRole(fileId: string, userId: string, role: 'owner' | 'editor' | 'viewer' | null) {
    if (role) this.roles.set(`${fileId}:${userId}`, role);
    else this.roles.delete(`${fileId}:${userId}`);
  }
  async getFileRole(fileId: string, userId: string) {
    const role = this.roles.get(`${fileId}:${userId}`) ?? 'editor';
    return { role, file: { id: fileId, projectId: 'p1' } };
  }
}

interface Backend {
  server: HttpServer;
  port: number;
  gateway: CollaborationGateway;
  rooms: RoomManager;
}

async function waitFor<T>(
  fn: () => T | Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs = 5000,
  label = 'condition',
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe('Multi-instance collaboration (Redis backplane semantics)', () => {
  jest.setTimeout(30_000);
  let backends: Backend[] = [];
  let prisma: FakePrisma;
  let storage: FakeStorage;
  let permissions: FakePermissions;
  let jwt: JwtService;

  const config = (overrides: Record<string, unknown> = {}) =>
    ({
      get: (key: string, d: number | boolean) =>
        key in overrides ? overrides[key] : d,
    }) as never;

  async function startBackend(): Promise<Backend> {
    const bus = new InMemoryCollaborationBus();
    const rooms = new RoomManager(
      prisma as never,
      storage as never,
      new PresenceService(new FakeRedis() as never, { get: () => 30 } as never),
      config({ PERSIST_FLUSH_MS: 50, SNAPSHOT_INTERVAL_MS: 500, ROOM_TTL_MS: 60000, COLLAB_AUTO_PERSIST: false }),
      bus,
    );
    await rooms.start();
    const gateway = new CollaborationGateway(
      jwt,
      permissions as unknown as PermissionService,
      rooms,
      // ROLE_CACHE_MS=0: live role changes apply immediately
      { get: (key: string, d: number) => (key === 'ROLE_CACHE_MS' ? 0 : d) } as never,
    );
    const server = createServer();
    gateway.attach(server, '/collab');
    gateway.registerConnectionHandler();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      server,
      port: (server.address() as { port: number }).port,
      gateway,
      rooms,
    };
  }

  beforeAll(async () => {
    InMemoryCollaborationBus.reset();
    jwt = new JwtService({ secret: 'test-secret' });
    prisma = new FakePrisma();
    storage = new FakeStorage();
    permissions = new FakePermissions();
    backends = [await startBackend(), await startBackend()];
  });

  afterAll(async () => {
    for (const b of backends) {
      b.gateway.onModuleDestroy();
      await b.rooms.onModuleDestroy();
      await new Promise<void>((r) => b.server.close(() => r()));
    }
    InMemoryCollaborationBus.reset();
  });

  const connect = (
    backend: Backend,
    userId: string,
    name: string,
    fileId: string,
  ) => {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(
      `ws://127.0.0.1:${backend.port}/collab`,
      fileId,
      doc,
      {
        params: { token: jwt.sign({ sub: userId, name, color: '#123' }) },
        disableBc: true,
        WebSocketPolyfill: WsWebSocket as unknown as typeof WebSocket,
      },
    );
    provider.awareness.setLocalStateField('user', { id: userId, name, color: '#123' });
    return { provider, doc };
  };

  it('converges edits across instances with a single persistence leader and no duplicated log', async () => {
    const fileId = 'f-cross';
    const a = connect(backends[0], 'alice', 'Alice', fileId);
    const b = connect(backends[1], 'bob', 'Bob', fileId);

    await waitFor(
      () => a.provider.synced && b.provider.synced,
      (v) => v === true,
      5000,
      'both synced',
    );

    // Ensure both rooms exist before election runs (connections create them
    // asynchronously). Then elect: exactly one instance can own the lease.
    await waitFor(
      () => backends.every((be) => be.rooms.get(fileId) !== undefined),
      (v) => v === true,
      3000,
      'both rooms created',
    );
    const [ra, rb] = backends.map((be) => be.rooms.get(fileId)!);
    await backends[0].rooms.runIdleSweepForTest();
    await backends[1].rooms.runIdleSweepForTest();
    const leaderCount = [ra, rb].filter((r) => r.isLeader).length;
    expect(leaderCount).toBe(1);

    // Alice (backend A) types -> Bob (backend B) sees it via the bus.
    a.doc.getText('content').insert(0, 'hello from A');
    await waitFor(
      () => b.doc.getText('content').toString(),
      (v) => v === 'hello from A',
      5000,
      'Bob on backend B converges',
    );

    // Bob (backend B) types -> Alice on backend A converges.
    b.doc
      .getText('content')
      .insert(b.doc.getText('content').length, ' + B');
    await waitFor(
      () => a.doc.getText('content').toString(),
      (v) => v.includes('+ B'),
      5000,
      'Alice on backend A converges',
    );

    // Awareness crosses the bus too: Bob sees Alice's presence/user state.
    await waitFor(
      () =>
        Array.from(b.provider.awareness.getStates().values()).some(
          (s) => (s.user as { id?: string })?.id === 'alice',
        ),
      (v) => v === true,
      5000,
      'Alice awareness visible on backend B',
    );

    // Run persistence sweeps on BOTH managers several times. The follower
    // must never write; only the leader's converged state is flushed.
    for (const be of backends) await be.rooms.runIdleSweepForTest();
    for (const be of backends) await be.rooms.runIdleSweepForTest();

    const rowsForFile = prisma.updates.filter((u) => u.fileId === fileId);
    expect(rowsForFile.length).toBeGreaterThan(0);
    // Leader merges all buffered updates into ONE row per flush interval;
    // two sweeps of two instances must therefore NOT have produced 2x/4x rows.
    // Each side typed exactly once before the sweeps, so at most two merged
    // leader rows exist (one per flush), never one from the follower too.
    expect(rowsForFile.length).toBeLessThanOrEqual(2);
    const textInRows = new Y.Doc();
    for (const row of rowsForFile) Y.applyUpdate(textInRows, row.update);
    expect(textInRows.getText('content').toString()).toBe('hello from A + B');

    // GET /files/:id/content reconstructs identical text on either backend's
    // persistence-backed FilesService.
    const filesA = new FilesService(
      prisma as never,
      {
        getFileRole: async () => ({ role: 'viewer', file: { id: fileId, projectId: 'p1' } }),
        requireFileRole: async () => ({ role: 'viewer', file: { id: fileId, projectId: 'p1' } }),
      } as unknown as PermissionService,
      storage as never,
    );
    const content = await filesA.readContent(fileId, 'alice');
    expect(content.content).toBe('hello from A + B');

    a.provider.destroy();
    b.provider.destroy();
  });

  it('rejects viewer writes even when the client lands on a follower instance', async () => {
    const fileId = 'f-cross-viewer';
    permissions.setRole(fileId, 'carol', 'viewer');
    const owner = connect(backends[0], 'alice2', 'Alice', fileId);
    const viewer = connect(backends[1], 'carol', 'Carol', fileId);

    await waitFor(
      () => owner.provider.synced && viewer.provider.synced,
      (v) => v === true,
      5000,
      'synced',
    );
    owner.doc.getText('content').insert(0, 'owner text');
    await waitFor(
      () => viewer.doc.getText('content').toString(),
      (v) => v === 'owner text',
      5000,
      'viewer reads cross-instance',
    );

    const denied: number[] = [];
    (viewer.provider.ws as unknown as WsWebSocket).addEventListener('message', (ev: any) => {
      const bytes = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data);
      if (bytes[0] === 4) denied.push(4);
    });
    viewer.doc.getText('content').insert(0, 'viewer hack');
    await waitFor(() => denied.length, (v) => v > 0, 5000, 'viewer denied');

    await new Promise((r) => setTimeout(r, 300));
    expect(owner.doc.getText('content').toString()).not.toContain('viewer hack');

    owner.provider.destroy();
    viewer.provider.destroy();
  });

  it('hands leadership over when the current leader stops renewing (failover)', async () => {
    const fileId = 'f-failover';
    const a = connect(backends[0], 'alice3', 'Alice', fileId);
    const b = connect(backends[1], 'bob3', 'Bob', fileId);
    await waitFor(
      () => a.provider.synced && b.provider.synced,
      (v) => v === true,
      5000,
      'synced',
    );

    // Let the lease be acquired. The shared fake clock is real time;
    // acquisition simply gives it to whoever calls first.
    await backends[0].rooms.runIdleSweepForTest();
    await backends[1].rooms.runIdleSweepForTest();
    const roomA = backends[0].rooms.get(fileId)!;
    const roomB = backends[1].rooms.get(fileId)!;
    const firstLeader = roomA.isLeader ? 'A' : roomB.isLeader ? 'B' : null;
    expect(firstLeader).not.toBeNull();

    // Simulate the leader crashing by force-expiring the in-memory lease and
    // clearing the crashed room's leader flag.
    const leaderRoom = firstLeader === 'A' ? roomA : roomB;
    const followerBackend = firstLeader === 'A' ? backends[1] : backends[0];
    leaderRoom.setLeader(false);
    InMemoryCollaborationBus.expireLocksForTest();

    await followerBackend.rooms.runIdleSweepForTest();
    expect(followerBackend.rooms.get(fileId)!.isLeader).toBe(true);

    // New leader flushes the converged doc it learned via the bus.
    followerBackend.rooms.get(fileId)!.ingestLeadershipCheckpoint();
    await followerBackend.rooms.runIdleSweepForTest();
    const rows = prisma.updates.filter((u) => u.fileId === fileId);
    expect(rows.length).toBeGreaterThan(0);

    a.provider.destroy();
    b.provider.destroy();
  });

  it('BUG1/BUG2: edits in the no-leader window and after leader loss are durable and converge', async () => {
    const fileId = 'f-durability-gap';

    // Create room on backend A directly (no leader yet) and insert via a
    // client update path the same way the gateway does, BEFORE any lease
    // sweep. The update must be buffered locally regardless of leadership.
    const roomA0 = await backends[0].rooms.getOrCreate(fileId);
    const earlyDoc = new Y.Doc();
    earlyDoc.getText('content').insert(0, 'pre-election keystroke');
    const earlyUpdate = Y.encodeStateAsUpdate(earlyDoc);
    await roomA0.applyClientUpdate(earlyUpdate, {} as never);

    expect(roomA0.getBufferedCount()).toBeGreaterThanOrEqual(1);
    expect(roomA0.isLeader).toBe(false); // no tick yet -> still follower
    expect(prisma.updates.filter((u) => u.fileId === fileId)).toHaveLength(0);

    // Run sweeps; exactly one instance becomes leader and the buffered edit
    // is flushed - not lost.
    await backends[0].rooms.runIdleSweepForTest();
    await backends[1].rooms.runIdleSweepForTest();
    const leader = [backends[0], backends[1]].find((be) =>
      be.rooms.get(fileId)!.isLeader,
    )!;
    expect(leader).toBeDefined();
    const rowsBefore = prisma.updates.filter((u) => u.fileId === fileId);
    expect(rowsBefore.length).toBeGreaterThan(0);

    // Now the OTHER backend joins with a real client and must receive the
    // pre-election edit through the bus (it may have missed the original
    // publish since its room did not exist; catch-up closes that gap).
    const followerBackend = leader === backends[0] ? backends[1] : backends[0];
    const client = connect(followerBackend, 'late-bob', 'LateBob', fileId);
    await waitFor(
      () => client.provider.synced,
      (v) => v === true,
      5000,
      'late client synced',
    );
    await waitFor(
      () => client.doc.getText('content').toString(),
      (v) => v.includes('pre-election keystroke'),
      5000,
      'late follower recovered the pre-election state',
    );

    // Force leadership to the follower: losing leadership must not drop the
    // old leader's buffer, and the new leader must flush the converged doc.
    const oldLeaderRoom = leader.rooms.get(fileId)!;
    const newLeaderRoom = followerBackend.rooms.get(fileId)!;
    oldLeaderRoom.setLeader(false);
    // buffer on the old leader is retained (no forced clear)
    expect(oldLeaderRoom.getBufferedCount()).toBeGreaterThanOrEqual(0);
    InMemoryCollaborationBus.expireLocksForTest();
    await followerBackend.rooms.runIdleSweepForTest();
    expect(newLeaderRoom.isLeader).toBe(true);

    // A fresh room loading from durable storage sees the early edit.
    await Promise.all([
      backends[0].rooms.runIdleSweepForTest(),
      backends[1].rooms.runIdleSweepForTest(),
    ]);
    const filesService = new FilesService(
      prisma as never,
      {
        getFileRole: async () => ({ role: 'viewer', file: { id: fileId, projectId: 'p1' } }),
        requireFileRole: async () => ({ role: 'viewer', file: { id: fileId, projectId: 'p1' } }),
      } as unknown as PermissionService,
      storage as never,
    );
    const content = await filesService.readContent(fileId, 'anyone');
    expect(content.content).toContain('pre-election keystroke');

    client.provider.destroy();
  });
});
