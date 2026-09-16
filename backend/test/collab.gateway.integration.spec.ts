import { createServer, type Server as HttpServer } from 'http';
import { JwtService } from '@nestjs/jwt';
import { WebSocket as WsWebSocket } from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { CollaborationGateway } from '../src/collaboration/collaboration.gateway';
import { RoomManager } from '../src/collaboration/room-manager';
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
    deleteMany: async () => {
      this.updates = [];
      return { count: 0 };
    },
  };

  fileSnapshot = {
    findFirst: async ({ where }: { where: { fileId: string } }) =>
      this.snapshots.filter((s) => s.fileId === where.fileId).at(-1) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `s${this.snapshots.length}`, ...data } as never;
      this.snapshots.push(row as never);
      return row;
    },
    count: async ({ where }: { where: { fileId: string } }) =>
      this.snapshots.filter((s) => s.fileId === where.fileId).length,
    deleteMany: async () => ({ count: 0 }),
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
  roleFor(userId: string): 'owner' | 'editor' | 'viewer' | null {
    if (userId === 'owner-1') return 'owner';
    if (userId === 'editor-1' || userId === 'editor-2') return 'editor';
    if (userId === 'viewer-1') return 'viewer';
    return null;
  }

  async getFileRole(fileId: string, userId: string) {
    const role = this.roleFor(userId);
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

  beforeAll(async () => {
    jwt = new JwtService({ secret: 'test-secret' });
    prisma = new FakePrisma();
    storage = new FakeStorage();
    const presence = new PresenceService(
      new FakeRedis() as never,
      { get: (_k: string, d: number) => d } as never,
    );
    rooms = new RoomManager(
      prisma as never,
      storage as never,
      presence,
      { get: (_k: string, d: number) => d } as never,
    );
    gateway = new CollaborationGateway(
      jwt,
      new FakePermissions() as unknown as PermissionService,
      rooms,
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
});
