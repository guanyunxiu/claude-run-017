import { createServer, type Server as HttpServer } from 'http';
import { JwtService } from '@nestjs/jwt';
import { WebSocket as WsWebSocket } from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { CollaborationGateway } from '../src/collaboration/collaboration.gateway';
import { Room, RoomManager } from '../src/collaboration/room-manager';
import { LocalCollaborationBus } from '../src/collaboration/bus/local-collaboration-bus';
import { LiveSessionService } from '../src/collaboration/live-session.service';
import { PresenceService } from '../src/collaboration/presence.service';
import { PermissionService } from '../src/projects/permission.service';

/*
 * Full WebSocket integration test: a real HTTP server upgraded by our
 * y-websocket-compatible gateway, with two real y-websocket clients.
 * No database / Redis / S3 is required - thin in-memory fakes stand in.
 */

class FakePrisma {
  updates: Array<{ id: bigint; fileId: string; update: Buffer; sizeBytes: number }> = [];
  snapshots: Array<{
    id: string;
    fileId: string;
    version: number;
    s3Key: string;
    lastUpdateId: number;
  }> = [];
  private nextId = 1n;

  documentUpdate = {
    create: async ({ data }: { data: { fileId: string; update: Buffer; sizeBytes: number } }) => {
      const row = { id: this.nextId++, ...data };
      this.updates.push(row);
      return { id: row.id };
    },
    findMany: async ({ where }: { where: { fileId: string } }) =>
      this.updates
        .filter((u) => u.fileId === where.fileId)
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    deleteMany: async ({
      where,
    }: {
      where?: { fileId?: string; id?: { lte?: bigint } };
    } = {}) => {
      const before = this.updates.length;
      this.updates = this.updates.filter((u) => {
        if (where?.fileId && u.fileId === where.fileId) {
          return where.id?.lte !== undefined && u.id > where.id.lte;
        }
        return true;
      });
      return { count: before - this.updates.length };
    },
  };

  fileSnapshot = {
    findFirst: async ({ where }: { where: { fileId: string } }) =>
      this.snapshots.filter((s) => s.fileId === where.fileId).at(-1) ?? null,
    findMany: async (args: {
      where?: { fileId?: string; version?: { lt?: number } };
      orderBy?: { version?: 'asc' | 'desc' };
      take?: number;
    } = {}) => {
      let rows = [...this.snapshots];
      if (args.where?.fileId) rows = rows.filter((s) => s.fileId === args.where!.fileId);
      if (args.where?.version?.lt !== undefined)
        rows = rows.filter((s) => s.version < args.where!.version!.lt!);
      rows.sort((a, b) =>
        args.orderBy?.version === 'asc' ? a.version - b.version : b.version - a.version,
      );
      if (args.take) rows = rows.slice(0, args.take);
      return rows;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `s${this.snapshots.length}`, ...data } as never;
      this.snapshots.push(row as never);
      return row;
    },
    count: async ({ where }: { where: { fileId: string } }) =>
      this.snapshots.filter((s) => s.fileId === where.fileId).length,
    deleteMany: async ({ where }: { where: { id?: string } }) => {
      const before = this.snapshots.length;
      this.snapshots = this.snapshots.filter((s) => s.id !== where.id);
      return { count: before - this.snapshots.length };
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
  async hset() {
    return 1;
  }
  async expire() {
    return 1;
  }
  async hdel() {
    return 1;
  }
  async hgetall() {
    return {};
  }
  async hlen() {
    return 0;
  }
}

class FakePermissions {
  /**
   * `${fileId}:${userId}` -> role. An explicit null means access was revoked
   * (must NOT fall through to the built-in default roles).
   */
  roles = new Map<string, 'owner' | 'editor' | 'viewer' | null>();

  setRole(fileId: string, userId: string, role: 'owner' | 'editor' | 'viewer' | null) {
    this.roles.set(`${fileId}:${userId}`, role);
  }

  roleFor(fileId: string, userId: string): 'owner' | 'editor' | 'viewer' | null {
    if (this.roles.has(`${fileId}:${userId}`)) {
      return this.roles.get(`${fileId}:${userId}`) ?? null;
    }
    if (userId === 'owner-1') return 'owner';
    if (userId === 'editor-1' || userId === 'editor-2') return 'editor';
    if (userId === 'viewer-1') return 'viewer';
    return null;
  }

  async getFileRole(fileId: string, userId: string) {
    const role = this.roleFor(fileId, userId);
    return role ? { role, file: { id: fileId, projectId: 'p1' } } : null;
  }
}

async function waitFor<T>(
  fn: () => T | Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs = 4000,
  label = 'condition',
): Promise<T> {
  const start = Date.now();
  let last: T;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    last = await fn();
    if (predicate(last)) return last;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe('Collaboration WebSocket gateway (integration)', () => {
  let httpServer: HttpServer;
  let port: number;
  let gateway: CollaborationGateway;
  let rooms: RoomManager;
  let prisma: FakePrisma;
  let storage: FakeStorage;
  let jwt: JwtService;
  let permissions: FakePermissions;
  let liveSessions: LiveSessionService;

  beforeAll(async () => {
    jwt = new JwtService({ secret: 'test-secret' });
    prisma = new FakePrisma();
    storage = new FakeStorage();
    permissions = new FakePermissions();
    const bus = new LocalCollaborationBus();
    liveSessions = new LiveSessionService(bus as never);
    const presence = new PresenceService(
      new FakeRedis() as never,
      { get: (_k: string, d: number) => d } as never,
    );
    rooms = new RoomManager(
      prisma as never,
      storage as never,
      presence,
      // Tests drive persistence explicitly via runIdleSweepForTest(); the
      // background timer is disabled so it cannot evict rooms mid-scenario.
      {
        get: (key: string, d: number | boolean) =>
          key === 'PERSIST_FLUSH_MS'
            ? 50
            : key === 'SNAPSHOT_INTERVAL_MS'
              ? 300
              : key === 'ROOM_TTL_MS'
                ? 300
                : key === 'COLLAB_AUTO_PERSIST'
                  ? false
                  : d,
      } as never,
      bus as never,
    );
    gateway = new CollaborationGateway(
      jwt,
      permissions as unknown as PermissionService,
      rooms,
      // Zero role cache: a downgrade applies to the very next edit frame.
      { get: (key: string, d: number) => (key === 'ROLE_CACHE_MS' ? 0 : d) } as never,
      liveSessions,
    );

    httpServer = createServer();
    gateway.attach(httpServer, '/collab');
    gateway.registerConnectionHandler();

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('bad address');
    port = addr.port;
  });

  afterAll(async () => {
    gateway.onModuleDestroy();
    await rooms.onModuleDestroy();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  const token = (sub: string, name: string, color: string) =>
    jwt.sign({ sub, name, color });

  function connectClient(
    userId: string,
    name: string,
    color: string,
    fileId = 'f1',
  ): { provider: WebsocketProvider; doc: Y.Doc } {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(
      `ws://127.0.0.1:${port}/collab`,
      fileId,
      doc,
      {
        params: { token: token(userId, name, color) },
        connect: true,
        // In a single Node process y-websocket would otherwise shortcut
        // through the global BroadcastChannel, bypassing the server under
        // test. (Real browsers only share BC within one browser origin.)
        disableBc: true,
        // Node 20 has no global WebSocket; inject the `ws` implementation.
        WebSocketPolyfill: WsWebSocket as unknown as typeof WebSocket,
      },
    );
    provider.awareness.setLocalStateField('user', {
      id: userId,
      name,
      color,
    });
    return { provider, doc };
  }

  it('rejects an unauthenticated upgrade', (done) => {
    const ws = new WsWebSocket(`ws://127.0.0.1:${port}/collab/f1`);
    ws.on('error', () => {
      // Unexpected server response / handshake failure.
      done();
    });
    ws.on('open', () => {
      done(new Error('expected upgrade to be rejected'));
    });
  });

  it('merges edits from two clients and propagates awareness/cursors', async () => {
    const a = connectClient('editor-1', 'Alice', '#f44336', 'r-merge');
    const b = connectClient('editor-2', 'Bob', '#2196f3', 'r-merge');

    await waitFor(
      () => a.provider.synced && b.provider.synced,
      (v) => v === true,
      5000,
      'both clients synced',
    );

    a.doc.getText('content').insert(0, 'Hello from Alice');
    await waitFor(
      () => b.doc.getText('content').toString(),
      (v) => v === 'Hello from Alice',
      4000,
      "Bob's doc to receive Alice's edit",
    );

    b.doc.getText('content').insert(a.doc.getText('content').length, ' + Bob');
    await waitFor(
      () => a.doc.getText('content').toString(),
      (v) => v.includes('+ Bob'),
      4000,
      "Alice's doc to receive Bob's edit",
    );

    // Awareness: Alice shows up in Bob's presence state.
    const aliceState = await waitFor(
      () => {
        const states = Array.from(b.provider.awareness.getStates().values());
        return states.find(
          (s) => (s.user as { id?: string } | undefined)?.id === 'editor-1',
        );
      },
      (v) => v !== undefined,
      4000,
      'Alice in Bob awareness',
    );
    expect(aliceState?.user).toMatchObject({
      id: 'editor-1',
      name: 'Alice',
      color: '#f44336',
    });

    a.provider.destroy();
    b.provider.destroy();
  });

  it('persists updates to Postgres and compacts snapshots into S3', async () => {
    const a = connectClient('editor-1', 'Alice', '#f44336', 'r-persist');
    await waitFor(() => a.provider.synced, (v) => v === true, 5000, 'synced');
    const marker = `persisted-${Date.now()}`;
    a.doc.getText('content').insert(0, marker);
    await waitFor(
      () => a.doc.getText('content').toString(),
      (v) => v === marker,
      2000,
      'local insert',
    );

    const room = rooms.get('r-persist')!;
    await waitFor(
      () => room.getBufferedCount(),
      (v) => v > 0,
      4000,
      'server receives the update',
    );
    await room.flushUpdates();
    expect(prisma.updates.length).toBeGreaterThan(0);

    const snapshotted = await room.maybeSnapshot(true);
    expect(snapshotted).toBe(true);
    expect(storage.objects.size).toBeGreaterThan(0);

    // Snapshot decodes back to the same Yjs state.
    const key = [...storage.objects.keys()].find((k) =>
      k.startsWith('snapshots/r-persist/'),
    )!;
    const bytes = storage.objects.get(key)!;
    const restored = new Y.Doc();
    Y.applyUpdate(restored, bytes);
    expect(restored.getText('content').toString()).toBe(marker);

    a.provider.destroy();
  });

  it('denies writes to viewers but lets them read', async () => {
    const editor = connectClient('editor-1', 'Alice', '#f44336', 'r-viewer');
    await waitFor(
      () => editor.provider.synced,
      (v) => v === true,
      5000,
      'editor synced',
    );
    const marker = `viewer-test-${Date.now()}`;
    editor.doc.getText('content').insert(0, marker);

    const viewer = connectClient('viewer-1', 'Carol', '#4caf50', 'r-viewer');
    await waitFor(
      () => viewer.provider.synced,
      (v) => v === true,
      5000,
      'viewer synced',
    );

    // Viewer can read existing content.
    await waitFor(
      () => viewer.doc.getText('content').toString(),
      (v) => v.includes(marker),
      4000,
      'viewer receives content',
    );

    // Viewer edit attempt produces a permission-denied message (type 4).
    const denied: number[] = [];
    const raw = viewer.provider.ws as unknown as {
      addEventListener: (
        t: string,
        cb: (ev: { data: ArrayBuffer | Buffer }) => void,
      ) => void;
    };
    raw.addEventListener('message', (ev) => {
      const bytes =
        ev.data instanceof ArrayBuffer
          ? new Uint8Array(ev.data)
          : new Uint8Array(ev.data);
      if (bytes[0] === 4) denied.push(4);
    });

    viewer.doc.getText('content').insert(0, 'i am a viewer');
    await waitFor(() => denied.length, (v) => v > 0, 4000, 'permission denied');

    // Editor never observes the viewer's rejected edit.
    await new Promise((r) => setTimeout(r, 300));
    expect(editor.doc.getText('content').toString()).not.toContain('i am a viewer');

    editor.provider.destroy();
    viewer.provider.destroy();
  });

  it('cleans up awareness/presence when a client disconnects', async () => {
    const a = connectClient('editor-1', 'Alice', '#f44336', 'r-presence');
    const b = connectClient('editor-2', 'Bob', '#2196f3', 'r-presence');
    await waitFor(
      () => a.provider.synced && b.provider.synced,
      (v) => v === true,
      5000,
      'synced',
    );

    await waitFor(
      () => {
        const states = Array.from(b.provider.awareness.getStates().values());
        return states.some(
          (s) => (s.user as { id?: string } | undefined)?.id === 'editor-1',
        );
      },
      (v) => v === true,
      4000,
      'Alice visible to Bob',
    );

    a.provider.destroy();
    await waitFor(
      () => {
        const states = Array.from(b.provider.awareness.getStates().values());
        return !states.some(
          (s) => (s.user as { id?: string } | undefined)?.id === 'editor-1',
        );
      },
      (v) => v === true,
      4000,
      'Alice removed from Bob awareness after disconnect',
    );

    b.provider.destroy();
  });

  it('applies a live role downgrade without the client reconnecting', async () => {
    const roomId = 'r-downgrade';
    const editor = connectClient('editor-1', 'Alice', '#f44336', roomId);
    const peer = connectClient('editor-2', 'Bob', '#2196f3', roomId);
    await waitFor(
      () => editor.provider.synced && peer.provider.synced,
      (v) => v === true,
      5000,
      'both synced',
    );

    // Initially the editor can mutate the shared document.
    editor.doc.getText('content').insert(0, 'before downgrade\n');
    await waitFor(
      () => peer.doc.getText('content').toString(),
      (v) => v.includes('before downgrade'),
      4000,
      'peer receives edit before downgrade',
    );

    // Owner downgrades Alice editor -> viewer while her socket stays open.
    permissions.setRole(roomId, 'editor-1', 'viewer');

    // Collect server responses on Alice's socket and wait for the close/reason.
    const denied: number[] = [];
    let closeReason = '';
    const rawWs = editor.provider.ws as unknown as {
      addEventListener: (t: string, cb: (ev: unknown) => void) => void;
    };
    rawWs.addEventListener('message', (ev: unknown) => {
      const data = (ev as { data?: ArrayBuffer | Buffer }).data;
      if (!data) return;
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
      if (bytes[0] === 4) denied.push(4);
    });
    rawWs.addEventListener('close', (ev: unknown) => {
      closeReason = String((ev as { reason?: string }).reason ?? '');
    });

    editor.doc.getText('content').insert(0, 'after downgrade\n');
    await waitFor(() => denied.length, (v) => v > 0, 4000, 'denied frame after downgrade');

    // The rejected edit never reaches the peer.
    await new Promise((r) => setTimeout(r, 300));
    expect(peer.doc.getText('content').toString()).not.toContain('after downgrade');

    // Downgrade to viewer keeps the connection open (read access remains)...
    await new Promise((r) => setTimeout(r, 200));
    expect(closeReason).toBe('');

    // ...but fully revoking access closes the socket on the next edit.
    permissions.setRole(roomId, 'editor-1', null);
    editor.doc.getText('content').insert(0, 'after revoke\n');
    await waitFor(
      () => closeReason,
      (v) => v.length > 0,
      4000,
      'socket closed after access revocation',
    );

    editor.provider.destroy();
    peer.provider.destroy();
  });

  it('BUG: a removed member cannot re-pull the document or publish awareness from a stale socket', async () => {
    const roomId = 'r-removed-member';
    const removed = connectClient('editor-1', 'Removed', '#f00', roomId);
    const peer = connectClient('editor-2', 'Keeper', '#0f0', roomId);
    await waitFor(
      () => removed.provider.synced && peer.provider.synced,
      (v) => v === true,
      5000,
      'both synced',
    );

    // Initial legitimate reads work.
    peer.doc.getText('content').insert(0, 'secret content');
    await waitFor(
      () => removed.doc.getText('content').toString(),
      (v) => v === 'secret content',
      4000,
      'removed member initially receives edits',
    );

    // Owner removes the member from the project (permissions now return null).
    permissions.setRole(roomId, 'editor-1', null);
    let closeCode = 0;
    let closeReason = '';
    removed.provider.on('connection-close', (event: { code?: number; reason?: string } | null) => {
      closeCode = event?.code ?? 0;
      closeReason = event?.reason ?? '';
    });

    // Even a pure READ request (re-pull of the full document via sync
    // step1) must now be rejected: send a raw [0][0][empty-state-vector]
    // frame exactly like y-websocket does at connect/resync.
    const rawWs = removed.provider.ws as unknown as WsWebSocket;
    rawWs.send(Buffer.concat([
      Buffer.from([0, 0]),
      Buffer.from([0]), // empty encoded state vector: varUint length 0
    ]));

    await waitFor(
      () => closeCode,
      (v) => v === 1008,
      4000,
      'stale socket closed on document re-pull',
    );
    expect(closeReason).toMatch(/revoked/i);

    removed.provider.destroy();
    peer.provider.destroy();
  });

  it('BUG: awareness from a removed member is rejected and closes the socket', async () => {
    const roomId = 'r-removed-awareness';
    const removed = connectClient('editor-2', 'RemovedAW', '#f00', roomId);
    await waitFor(
      () => removed.provider.synced,
      (v) => v === true,
      5000,
      'synced',
    );
    permissions.setRole(roomId, 'editor-2', null);

    let closeCode = 0;
    removed.provider.on('connection-close', (event: { code?: number } | null) => {
      closeCode = event?.code ?? 0;
    });

    // Trigger a real y-protocols awareness frame by changing the local
    // awareness state (the user field is already present from connectClient).
    removed.provider.awareness.setLocalStateField('note', 'cursor update');
    await waitFor(
      () => closeCode,
      (v) => v === 1008,
      4000,
      'awareness frame closes the revoked socket',
    );

    removed.provider.destroy();
  });

  it('BUG: removing a member proactively closes their live socket without any frame from them', async () => {
    const roomId = 'r-proactive-kick';
    const victim = connectClient('editor-1', 'Victim', '#f00', roomId);
    await waitFor(
      () => victim.provider.synced,
      (v) => v === true,
      5000,
      'synced',
    );
    // Connection registration happens inside the async 'connection' handler.
    await waitFor(
      () => liveSessions.count('editor-1'),
      (v) => v >= 1,
      3000,
      'socket registered in live session registry',
    );

    let closeCode = 0;
    victim.provider.on('connection-close', (event: { code?: number } | null) => {
      // Capture only the FIRST close (1008 from the kick). y-websocket then
      // auto-reconnects and those later attempts produce 1006 noise.
      if (closeCode === 0) closeCode = event?.code ?? 0;
    });

    // The REST member-removal hook fires while the victim sends NOTHING.
    permissions.setRole(roomId, 'editor-1', null);
    const kicked = await liveSessions.kick(
      'editor-1',
      'You were removed from this project',
    );
    expect(kicked).toBe(1);
    expect(liveSessions.count('editor-1')).toBe(0);

    await waitFor(
      () => closeCode,
      (v) => v === 1008,
      3000,
      'live socket proactively closed with policy-violation',
    );

    victim.provider.destroy();
  });

  it('compacts S3 snapshots while a room stays continuously active', async () => {
    const roomId = 'r-active-snapshot';
    const a = connectClient('editor-1', 'Alice', '#f44336', roomId);
    await waitFor(() => a.provider.synced, (v) => v === true, 5000, 'synced');

    const room = rooms.get(roomId)!;
    const snapsBefore = storage.objects.size;

    // Simulate continuous collaboration across multiple snapshot intervals.
    // Persistence is driven explicitly (the manager background timer is off
    // in tests): each pass flushes, then compacts once the interval elapses.
    for (let i = 0; i < 3; i++) {
      a.doc
        .getText('content')
        .insert(a.doc.getText('content').length, `line ${i}\n`);
      await waitFor(
        () => room.getBufferedCount(),
        (v) => v > 0,
        4000,
        'server receives update',
      );
      await room.flushUpdates();
      await new Promise((r) => setTimeout(r, 320)); // > snapshotMs (300ms)
      await room.maybeSnapshot();
    }

    expect(storage.objects.size).toBeGreaterThan(snapsBefore);
    const activeSnapshots = [...storage.objects.keys()].filter((k) =>
      k.includes(roomId),
    );
    expect(activeSnapshots.length).toBeGreaterThan(0);

    // Snapshot bytes decode to the converged text.
    const latestKey = activeSnapshots.at(-1)!;
    const restored = new Y.Doc();
    Y.applyUpdate(restored, storage.objects.get(latestKey)!);
    const text = restored.getText('content').toString();
    expect(text).toContain('line 0');
    expect(text).toContain('line 2');

    a.provider.destroy();
  });

  it('keeps a room in memory when eviction persistence fails, then flushes on retry', async () => {
    // A dedicated room manager pointed at a storage backend that fails.
    const failingPrisma = new FakePrisma();
    let failFlush = true;
    const origCreate = failingPrisma.documentUpdate.create.bind(
      failingPrisma.documentUpdate,
    );
    failingPrisma.documentUpdate.create = async (args: {
      data: { fileId: string; update: Buffer; sizeBytes: number };
    }) => {
      if (failFlush && args.data.fileId === 'r-fail-evict') {
        throw new Error('simulated postgres outage');
      }
      return origCreate(args);
    };
    const failingRooms = new RoomManager(
      failingPrisma as never,
      storage as never,
      new PresenceService(new FakeRedis() as never, {
        get: (_k: string, d: number) => d,
      } as never),
      {
        get: (key: string, d: number | boolean) =>
          key === 'PERSIST_FLUSH_MS'
            ? 20
            : key === 'SNAPSHOT_INTERVAL_MS'
              ? 10_000
              : key === 'ROOM_TTL_MS'
                ? 30
                : key === 'COLLAB_AUTO_PERSIST'
                  ? false
                  : d,
      } as never,
      new LocalCollaborationBus(),
    );
    const room = await failingRooms.getOrCreate('r-fail-evict');
    room.doc.getText('content').insert(0, 'must not be lost');
    expect(room.getBufferedCount()).toBe(1);

    // Wait past ROOM_TTL_MS (30ms) with no connections, then attempt eviction.
    await new Promise((r) => setTimeout(r, 60));
    await failingRooms.runIdleSweepForTest();
    expect(failingRooms.get('r-fail-evict')).toBe(room);
    expect(room.getBufferedCount()).toBe(1); // updates retained in memory

    // Backend recovers: next successful eviction persists and removes the room.
    failFlush = false;
    failingRooms.resetRetryCooldownForTest('r-fail-evict');
    await failingRooms.runIdleSweepForTest();
    expect(failingRooms.get('r-fail-evict')).toBeUndefined();

    // Reconstruct from storage: the edit that "failed" earlier is present.
    const reloaded = new Room(
      'r-fail-evict',
      failingPrisma as never,
      storage as never,
      new PresenceService(new FakeRedis() as never, {
        get: (_k: string, d: number) => d,
      } as never),
      20,
      10_000,
      new LocalCollaborationBus(),
    );
    await reloaded.ensureLoaded();
    expect(reloaded.doc.getText('content').toString()).toBe('must not be lost');

    await failingRooms.onModuleDestroy();
  });
});
