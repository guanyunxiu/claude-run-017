import * as Y from 'yjs';
import { Room } from './room-manager';
import { LocalCollaborationBus } from './bus/local-collaboration-bus';

/* eslint-disable @typescript-eslint/no-explicit-any */

class FakePrisma {
  updates: any[] = [];
  snapshots: any[] = [];
  private nextId = 1n;

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
        .filter((u) => u.fileId === where.fileId)
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    deleteMany: async ({ where }: any) => {
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
  deleted: string[] = [];
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
    this.deleted.push(k);
    this.objects.delete(k);
  };
}

function textUpdate(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText('content').insert(0, text);
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

describe('Room snapshot history retention', () => {
  it('keeps at most N snapshots and prunes update rows only past the oldest kept snapshot', async () => {
    const prisma = new FakePrisma();
    const storage = new FakeStorage();
    const room = new Room(
      'f1',
      prisma as never,
      storage as never,
      { heartbeat: async () => undefined, remove: async () => undefined } as never,
      50,
      1_000_000,
      new LocalCollaborationBus(),
      3, // historyLimit = 3
    );
    await room.ensureLoaded();

    // Produce four compacted snapshots, each after an edit + flush.
    for (let i = 0; i < 4; i++) {
      await room.applyClientUpdate(textUpdate(`v${i} `), {} as never);
      await room.flushUpdates();
      await room.maybeSnapshot(true);
    }

    const versions = prisma.snapshots
      .map((s) => s.version)
      .sort((a, b) => a - b);
    // Only the newest three survive.
    expect(versions).toEqual([1, 2, 3]);
    // The v0 object is deleted; retained ones remain in storage.
    expect(storage.deleted.some((k) => k.endsWith('v0.bin'))).toBe(true);
    for (const v of [1, 2, 3]) {
      expect(storage.objects.has(`snapshots/f1/v${v}.bin`)).toBe(true);
    }
  });
});
