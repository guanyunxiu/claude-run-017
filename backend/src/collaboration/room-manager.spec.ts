import * as Y from 'yjs';
import { Room } from './room-manager';

type UpdateRow = {
  id: bigint;
  fileId: string;
  update: Buffer;
  sizeBytes: number;
};

class FakePrisma {
  updates: UpdateRow[] = [];
  snapshots: Array<{
    id: string;
    fileId: string;
    version: number;
    s3Key: string;
    lastUpdateId: number;
  }> = [];
  private nextId = 1n;

  fileSnapshot = {
    findFirst: async ({ where }: { where: { fileId: string } }) =>
      this.snapshots
        .filter((s) => s.fileId === where.fileId)
        .sort((a, b) => b.version - a.version)[0] ?? null,
    create: async ({ data }: { data: Omit<UpdateRow, never> | Record<string, unknown> }) => {
      const row = { id: `snap-${this.snapshots.length}`, ...(data as object) } as never;
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

  documentUpdate = {
    create: async ({ data }: { data: { fileId: string; update: Buffer; sizeBytes: number } }) => {
      const row: UpdateRow = { id: this.nextId++, ...data };
      this.updates.push(row);
      return { id: row.id };
    },
    findMany: async ({
      where,
    }: {
      where: { fileId: string; id?: { gt?: bigint; lte?: bigint } };
    }) =>
      this.updates
        .filter((u) => {
          if (u.fileId !== where.fileId) return false;
          if (where.id?.gt !== undefined && u.id <= where.id.gt) return false;
          if (where.id?.lte !== undefined && u.id > where.id.lte) return false;
          return true;
        })
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    deleteMany: async ({
      where,
    }: {
      where: { fileId: string; id?: { lte: bigint } };
    }) => {
      const before = this.updates.length;
      this.updates = this.updates.filter(
        (u) => !(u.fileId === where.fileId && where.id && u.id <= where.id.lte),
      );
      return { count: before - this.updates.length };
    },
  };

  file = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === 'f1' ? { id: 'f1' } : null,
  };
}

class FakeStorage {
  objects = new Map<string, Uint8Array>();
  snapshotKey = (fileId: string, v: number) => `snapshots/${fileId}/v${v}.bin`;
  putSnapshot = async (key: string, bytes: Uint8Array) => {
    this.objects.set(key, bytes);
  };
  getSnapshot = async (key: string) => {
    const v = this.objects.get(key);
    if (!v) throw new Error('missing ' + key);
    return v;
  };
  deleteSnapshot = async (key: string) => {
    this.objects.delete(key);
  };
}

class FakePresence {
  heartbeats: Array<{ documentId: string; clientId: number }> = [];
  async heartbeat(documentId: string, user: { clientId: number }) {
    this.heartbeats.push({ documentId, clientId: user.clientId });
  }
  async remove() {
    /* noop */
  }
}

function makeRoom(flushMs = 50, snapshotMs = 1_000_000) {
  const prisma = new FakePrisma();
  const storage = new FakeStorage();
  const presence = new FakePresence();
  const room = new Room(
    'f1',
    prisma as never,
    storage as never,
    presence as never,
    flushMs,
    snapshotMs,
  );
  return { room, prisma, storage, presence };
}

describe('Room persistence', () => {
  it('buffers doc updates and flushes merged updates to Postgres', async () => {
    const { room, prisma } = makeRoom();
    await room.ensureLoaded();

    room.doc.getText('content').insert(0, 'hello');
    room.doc.getText('content').insert(5, ' world');
    expect(room.getBufferedCount()).toBe(2);

    const flushed = await room.flushUpdates();
    expect(flushed).toBe(2);
    expect(prisma.updates).toHaveLength(1);
    expect(room.getBufferedCount()).toBe(0);

    // Reload into a fresh room and verify content reconstruction.
    const room2 = new Room(
      'f1',
      prisma as never,
      new FakeStorage() as never,
      new FakePresence() as never,
      50,
      1_000_000,
    );
    await room2.ensureLoaded();
    expect(room2.doc.getText('content').toString()).toBe('hello world');
  });

  it('writes an S3 snapshot and prunes the incorporated update tail', async () => {
    const { room, prisma, storage } = makeRoom(50, 0);
    await room.ensureLoaded();
    room.doc.getText('content').insert(0, 'snapshot me');
    await room.flushUpdates();

    const snapshotted = await room.maybeSnapshot(true);
    expect(snapshotted).toBe(true);
    expect(storage.objects.size).toBe(1);
    expect(prisma.updates).toHaveLength(0);
    expect(prisma.snapshots).toHaveLength(1);

    // A new room loads the snapshot only.
    const room2 = new Room(
      'f1',
      prisma as never,
      storage as never,
      new FakePresence() as never,
      50,
      1_000_000,
    );
    await room2.ensureLoaded();
    expect(room2.doc.getText('content').toString()).toBe('snapshot me');
  });

  it('converges when concurrent client updates are applied', async () => {
    const { room } = makeRoom();
    await room.ensureLoaded();
    const text = room.doc.getText('content');
    text.insert(0, 'AB');

    // Simulate two offline clients diverging from the same base then syncing.
    const base = Y.encodeStateAsUpdate(room.doc);
    const d1 = new Y.Doc();
    const d2 = new Y.Doc();
    Y.applyUpdate(d1, base);
    Y.applyUpdate(d2, base);
    d1.getText('content').insert(2, '-one');
    d2.getText('content').insert(2, '-two');

    room.applyClientUpdate(Y.encodeStateAsUpdate(d1), {} as never);
    room.applyClientUpdate(Y.encodeStateAsUpdate(d2), {} as never);

    const merged = text.toString();
    expect(merged).toContain('AB');
    expect(merged).toContain('-one');
    expect(merged).toContain('-two');
  });
});
