import * as Y from 'yjs';
import { Room } from './room-manager';
import { CollaborationBus } from './bus/collaboration-bus';

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
    deleteMany: async () => ({ count: 0 }),
  };
}

class FakeStorage {
  objects = new Map<string, Uint8Array>();
  failKeys?: Set<string>;
  snapshotKey = (f: string, v: number) => `snapshots/${f}/v${v}.bin`;
  putSnapshot = async (k: string, b: Uint8Array) => {
    this.objects.set(k, b);
  };
  getSnapshot = async (k: string) => {
    if (this.failKeys?.has(k)) throw new Error('object missing: ' + k);
    const v = this.objects.get(k);
    if (!v) throw new Error('missing ' + k);
    return v;
  };
  deleteSnapshot = async (k: string) => {
    this.objects.delete(k);
  };
}

/** Bus that records every doc-update published, with per-key failure control. */
class RecordingBus extends CollaborationBus {
  readonly instanceId = 'rec-1';
  readonly enabled = true;
  publishedDocUpdates: Uint8Array[] = [];
  async start() {}
  async subscribe() {}
  async unsubscribe() {}
  async publishDocUpdate(_f: string, u: Uint8Array) {
    this.publishedDocUpdates.push(u);
  }
  async publishAwareness() {}
  async publishSyncStep1() {}
  async publishSyncStep2() {}
  async publishPersisted() {}
  async publishKick() {}
  async publishRestorePrepare() {}
  async publishRestoreCommit() {}
  async publishRestoreAbort() {}
  async acquireLease() {
    return true;
  }
  async renewLease() {
    return true;
  }
  async releaseLease() {}
  async acquireRestoreLock() {
    return true;
  }
  async releaseRestoreLock() {}
  async stop() {}
}

function textUpdate(text: string): Uint8Array {
  const d = new Y.Doc();
  d.getText('content').insert(0, text);
  const u = Y.encodeStateAsUpdate(d);
  d.destroy();
  return u;
}

function makeRoom(bus: RecordingBus) {
  const prisma = new FakePrisma();
  const storage = new FakeStorage();
  const presence = {
    heartbeat: async () => undefined,
    remove: async () => undefined,
  };
  const room = new Room(
    'f1',
    prisma as never,
    storage as never,
    presence as never,
    50,
    1_000_000,
    bus,
    5,
  );
  return { room, prisma, storage };
}

describe('Restore barrier quarantine (BUG 1)', () => {
  it('does NOT publish or persist client edits made while the barrier is open', async () => {
    const bus = new RecordingBus();
    const { room, prisma } = makeRoom(bus);
    await room.ensureLoaded();
    room.setLeader(true);

    // Pre-barrier edit behaves normally.
    await room.applyClientUpdate(textUpdate('before'), {} as never);
    expect(bus.publishedDocUpdates).toHaveLength(1);
    await room.flushUpdates();

    // Open the barrier (as a prepare would).
    room.enterRestoreBarrier('rid-1');

    // Someone is still typing on this instance.
    const accepted = await room.applyClientUpdate(textUpdate('DURING RESTORE'), {} as never);
    expect(accepted).toBe(false);

    // Nothing crossed the bus during the barrier.
    expect(bus.publishedDocUpdates).toHaveLength(1);
    // And no buffered update exists that a flush could persist.
    expect(room.hasBufferedUpdates()).toBe(false);

    // A delayed bus update arriving at a barrier room is quarantined (not
    // applied to the doc), so it cannot mutate the reset basis or
    // resurrect content after commit.
    room.applyBusUpdate(textUpdate('IN-FLIGHT STRAY'));
    expect(room.doc.getText('content').toString()).not.toContain('IN-FLIGHT STRAY');

    // Commit the reset: the target snapshot bytes reset the room's own doc.
    const target = new Y.Doc();
    target.getText('content').insert(0, 'restored');
    const targetBytes = Y.encodeStateAsUpdate(target);
    target.destroy();
    room.applyRestoreCommit(targetBytes, 'rid-1');

    expect(room.doc.getText('content').toString()).toBe('restored');
    // Flushing after commit must not resurrect the quarantined edits.
    await room.flushUpdates();
    expect(room.doc.getText('content').toString()).toBe('restored');
    // Only the pre-barrier + restore durable rows exist; no during-barrier row.
    const texts = prisma.updates.map((r) => {
      const d = new Y.Doc();
      Y.applyUpdate(d, r.update);
      const t = d.getText('content').toString();
      d.destroy();
      return t;
    });
    expect(texts.join('|')).not.toContain('DURING RESTORE');
    expect(texts.join('|')).not.toContain('IN-FLIGHT STRAY');
  });

  it('abort replays quarantined bus updates so legitimate edits are not lost', async () => {
    const bus = new RecordingBus();
    const { room } = makeRoom(bus);
    await room.ensureLoaded();
    room.enterRestoreBarrier('rid-2');
    room.applyBusUpdate(textUpdate('legit'));
    expect(room.doc.getText('content').toString()).toBe('');
    room.abortRestoreBarrier('rid-2');
    expect(room.doc.getText('content').toString()).toBe('legit');
  });
});
