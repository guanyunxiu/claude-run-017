import * as Y from 'yjs';
import { Room } from './room-manager';
import { LocalCollaborationBus } from './bus/local-collaboration-bus';
import { SnapshotUnrecoverableException } from './room-manager';

/* eslint-disable @typescript-eslint/no-explicit-any */

class FakePrisma {
  updates: any[] = [];
  snapshots: any[] = [];
  private nextId = 1n;
  deletes: any[] = [];

  fileSnapshot = {
    findFirst: async ({ where }: any) =>
      this.snapshots
        .filter((s) => s.fileId === where.fileId)
        .sort((a, b) => b.version - a.version)[0] ?? null,
    findMany: async (args: any = {}) => {
      let rows = [...this.snapshots];
      if (args.where?.fileId) rows = rows.filter((s) => s.fileId === args.where.fileId);
      if (args.where?.version?.lt !== undefined)
        rows = rows.filter((s) => s.version < args.where.version.lt);
      rows.sort((a, b) =>
        args.orderBy?.version === 'asc' ? a.version - b.version : b.version - a.version,
      );
      if (args.take) rows = rows.slice(0, args.take);
      return rows;
    },
    create: async ({ data }: any) => {
      const row = { id: `snap-${this.snapshots.length}`, ...data };
      this.snapshots.push(row);
      return row;
    },
    deleteMany: async ({ where }: any) => {
      const before = this.snapshots.length;
      this.snapshots = this.snapshots.filter((s) => s.id !== where.id);
      return { count: before - this.snapshots.length };
    },
  };

  documentUpdate = {
    create: async ({ data }: any) => {
      const row = { id: this.nextId++, ...data };
      this.updates.push(row);
      return { id: row.id };
    },
    findMany: async ({ where }: any) =>
      this.updates
        .filter((u) => {
          if (u.fileId !== where.fileId) return false;
          if (where.id?.gt !== undefined && u.id <= where.id.gt) return false;
          return true;
        })
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    deleteMany: async ({ where }: any) => {
      this.deletes.push(where);
      const before = this.updates.length;
      this.updates = this.updates.filter(
        (u) => !(u.fileId === where.fileId && where.id?.lte !== undefined && u.id <= where.id.lte),
      );
      return { count: before - this.updates.length };
    },
  };
}

class FakeStorage {
  objects = new Map<string, Uint8Array>();
  /** Keys whose read should fail (simulate lost/corrupt object). */
  failKeys = new Set<string>();
  snapshotKey = (f: string, v: number) => `snapshots/${f}/v${v}.bin`;
  putSnapshot = async (k: string, b: Uint8Array) => {
    this.objects.set(k, b);
  };
  getSnapshot = async (k: string) => {
    if (this.failKeys.has(k)) throw new Error('NoSuchKey: ' + k);
    const v = this.objects.get(k);
    if (!v) throw new Error('missing ' + k);
    return v;
  };
  deleteSnapshot = async (k: string) => {
    this.objects.delete(k);
  };
}

function makeRoom(prisma: FakePrisma, storage: FakeStorage, historyLimit = 20) {
  const presence = { heartbeat: async () => undefined, remove: async () => undefined };
  const room = new Room(
    'f1',
    prisma as never,
    storage as never,
    presence as never,
    50,
    1_000_000,
    new LocalCollaborationBus(),
    historyLimit,
  );
  return room;
}

function snapshotBytes(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText('content').insert(0, text);
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

describe('Snapshot durability (BUG 2)', () => {
  it('falls back to an older readable snapshot plus a wider update tail when the newest object is lost', async () => {
    const prisma = new FakePrisma();
    const storage = new FakeStorage();

    // Seed: v0 object + its compacted pointer (lastUpdateId=5), and update
    // rows 6..10 that were compacted into a NEWER v1 snapshot pointer but
    // whose v1 OBJECT is lost. Simulate the old behaviour correctly: rows
    // 1..5 are pruned (only 6..10 remain), v0 readable, v1 object missing.
    prisma.snapshots.push(
      { id: 's0', fileId: 'f1', version: 0, s3Key: 'snapshots/f1/v0.bin', lastUpdateId: 5, sizeBytes: 1 },
      { id: 's1', fileId: 'f1', version: 1, s3Key: 'snapshots/f1/v1.bin', lastUpdateId: 10, sizeBytes: 1 },
    );
    storage.objects.set('snapshots/f1/v0.bin', snapshotBytes('version-zero'));
    // v1 object intentionally absent.
    storage.failKeys.add('snapshots/f1/v1.bin');

    // Tail rows 6..10: append ' delta' (id order matters).
    const deltaDoc = new Y.Doc();
    deltaDoc.getText('content').insert(deltaDoc.getText('content').length, ' delta');
    const delta = Y.encodeStateAsUpdate(deltaDoc);
    deltaDoc.destroy();
    for (let i = 6; i <= 10; i++) {
      prisma.updates.push({ id: BigInt(i), fileId: 'f1', update: Buffer.from(delta), sizeBytes: delta.byteLength });
    }

    const room = makeRoom(prisma, storage);
    await room.ensureLoaded();
    // Recovered from v0 (lastUpdateId=5) so rows 6..10 are applied.
    const text = room.doc.getText('content').toString();
    expect(text).toContain('version-zero');
    expect(text).toContain('delta');
  });

  it('throws instead of silently loading an empty doc when every snapshot is unreadable and the log is pruned', async () => {
    const prisma = new FakePrisma();
    const storage = new FakeStorage();
    prisma.snapshots.push({
      id: 's0',
      fileId: 'f1',
      version: 0,
      s3Key: 'snapshots/f1/v0.bin',
      lastUpdateId: 3,
      sizeBytes: 1,
    });
    storage.failKeys.add('snapshots/f1/v0.bin');
    // No update rows remain (already pruned).
    const room = makeRoom(prisma, storage);
    await expect(room.ensureLoaded()).rejects.toBeInstanceOf(
      SnapshotUnrecoverableException,
    );
  });

  it('does NOT prune update rows when the freshly written snapshot object fails read-back verification', async () => {
    const prisma = new FakePrisma();
    const storage = new FakeStorage();
    const room = makeRoom(prisma, storage);
    await room.ensureLoaded();
    room.setLeader(true);

    // One edit -> flush creates the update row.
    const d = new Y.Doc();
    d.getText('content').insert(0, 'hello');
    const update = Y.encodeStateAsUpdate(d);
    d.destroy();
    await room.applyClientUpdate(update, {} as never);
    await room.flushUpdates();
    const updateCount = prisma.updates.length;
    expect(updateCount).toBeGreaterThan(0);

    // Make the NEXT snapshot object unreadable immediately after put, to
    // simulate an object that reports success but cannot be read back.
    const originalGet = storage.getSnapshot.bind(storage);
    let calls = 0;
    storage.getSnapshot = async (k: string) => {
      calls++;
      // The first read-back after v0 write fails; subsequent reads of the
      // same key succeed (next compaction attempt).
      if (calls === 1) throw new Error('read-after-write failed');
      return originalGet(k);
    };

    await expect(room.maybeSnapshot(true)).rejects.toBeDefined();

    // The update log must still be intact (no pruning happened) and no
    // snapshot metadata was committed for the unverifiable object.
    expect(prisma.updates.length).toBe(updateCount);
    expect(prisma.snapshots.length).toBe(0);

    // A later successful compaction works and then prunes.
    storage.getSnapshot = originalGet;
    await room.maybeSnapshot(true);
    expect(prisma.snapshots.length).toBe(1);
  });
});
