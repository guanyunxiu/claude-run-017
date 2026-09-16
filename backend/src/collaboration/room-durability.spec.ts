import * as Y from 'yjs';
import { Room } from './room-manager';
import { CollaborationBus } from './bus/collaboration-bus';
import { PresenceService } from './presence.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

class FakePrisma {
  updates: any[] = [];
  snapshots: any[] = [];
  private nextId = 1n;
  fileSnapshot = {
    findFirst: async () => null,
    create: async ({ data }: any) => ({ id: 's1', ...data }),
    count: async () => 0,
    deleteMany: async () => ({ count: 0 }),
  };
  documentUpdate = {
    create: async ({ data }: any) => {
      const row = { id: this.nextId++, ...data };
      this.updates.push(row);
      return { id: row.id };
    },
    findMany: async ({ where }: any) =>
      this.updates.filter((u) => u.fileId === where.fileId),
    deleteMany: async () => ({ count: 0 }),
  };
  file = {
    findUnique: async ({ where }: any) => ({ id: where.id, language: 'typescript' }),
    findUniqueOrThrow: async ({ where }: any) => ({
      id: where.id,
      language: 'typescript',
    }),
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

/** Controllable bus: captures publishes and can be forced to fail. */
class ScriptedBus extends CollaborationBus {
  readonly instanceId: string;
  readonly enabled = true;
  published: { kind: string; payload: Uint8Array }[] = [];
  private failNext = 0;

  constructor(id = 'scripted') {
    super();
    this.instanceId = id;
  }
  async start() {}
  async subscribe() {}
  async unsubscribe() {}
  failPublishes(count: number) {
    this.failNext = count;
  }
  private async record(kind: string, payload: Uint8Array) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('redis unavailable');
    }
    this.published.push({ kind, payload });
  }
  publishDocUpdate(f: string, u: Uint8Array) {
    return this.record('doc-update', u);
  }
  publishAwareness(f: string, u: Uint8Array) {
    return this.record('awareness', u);
  }
  publishSyncStep1(f: string, u: Uint8Array) {
    return this.record('sync-step1', u);
  }
  publishSyncStep2(f: string, u: Uint8Array) {
    return this.record('sync-step2', u);
  }
  publishPersisted(f: string, u: Uint8Array) {
    return this.record('persisted', u);
  }
  async acquireLease() {
    return true; // tests drive leadership manually
  }
  async renewLease() {
    return true;
  }
  async releaseLease() {}
  async stop() {}
}

function makeRoom(bus: ScriptedBus) {
  const prisma = new FakePrisma();
  const storage = new FakeStorage();
  const presence = new PresenceService(new FakeRedis() as never, {
    get: (_k: string, d: number) => d,
  } as never);
  const room = new Room(
    'f1',
    prisma as never,
    storage as never,
    presence,
    50,
    1_000_000,
    bus,
  );
  return { room, prisma, storage };
}

/** Yjs update for a local text insert from a fresh doc. */
function localInsert(_room: Room, text: string): Uint8Array {
  const source = new Y.Doc();
  source.getText('content').insert(0, text);
  const update = Y.encodeStateAsUpdate(source);
  source.destroy();
  return update;
}

describe('Room durability with the Redis bus', () => {
  it('BUG1: buffers local edits BEFORE leadership is acquired', async () => {
    const bus = new ScriptedBus();
    const { room, prisma } = makeRoom(bus);
    await room.ensureLoaded();
    expect(room.isLeader).toBe(false);

    const update = localInsert(room, 'typed before election');
    // Simulate a websocket socket origin object.
    const fakeSocket = {} as never;
    await room.applyClientUpdate(update, fakeSocket);

    // The edit must be retained despite no leader existing yet.
    expect(room.getBufferedCount()).toBe(1);
    expect(prisma.updates).toHaveLength(0);

    // It was also handed to the bus for peers.
    expect(bus.published.some((p) => p.kind === 'doc-update')).toBe(true);

    // Election happens; the pre-leadership edit is flushed.
    room.setLeader(true);
    await room.flushUpdates();
    expect(prisma.updates).toHaveLength(1);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, prisma.updates[0].update);
    expect(restored.getText('content').toString()).toBe('typed before election');
  });

  it('BUG1: queued bus publish is retried after Redis failure without losing the edit', async () => {
    const bus = new ScriptedBus();
    const { room, prisma } = makeRoom(bus);
    await room.ensureLoaded();
    room.setLeader(true);

    bus.failPublishes(2); // first two attempts fail
    const update = localInsert(room, 'retry me');
    await room.applyClientUpdate(update, {} as never);

    expect(room.hasPendingPublishes()).toBe(true);
    expect(bus.published.filter((p) => p.kind === 'doc-update')).toHaveLength(0);
    // The edit still sits in the leader buffer.
    expect(room.getBufferedCount()).toBe(1);

    await room.drainPendingPublishes(); // still failing once
    expect(room.hasPendingPublishes()).toBe(true);
    await room.drainPendingPublishes(); // redis back
    expect(room.hasPendingPublishes()).toBe(false);
    expect(bus.published.filter((p) => p.kind === 'doc-update')).toHaveLength(1);

    await room.flushUpdates();
    expect(prisma.updates).toHaveLength(1);
  });

  it('BUG2: losing leadership does NOT discard unflushed local edits', async () => {
    const bus = new ScriptedBus();
    const { room } = makeRoom(bus);
    await room.ensureLoaded();
    room.setLeader(true);

    await room.applyClientUpdate(localInsert(room, 'unflushed local'), {} as never);
    expect(room.getBufferedCount()).toBe(1);

    // Leadership handed away: the buffer must survive for confirmation.
    room.setLeader(false);
    expect(room.getBufferedCount()).toBe(1);
    expect(room.hasUnconfirmedLocalEdits()).toBe(true);
  });

  it('BUG2: follower drops its local safety buffer only once the leader confirms durability', async () => {
    const bus = new ScriptedBus();
    const { room } = makeRoom(bus);
    await room.ensureLoaded();
    // Room is a follower.
    expect(room.isLeader).toBe(false);

    await room.applyClientUpdate(localInsert(room, 'follower edit'), {} as never);
    expect(room.getBufferedCount()).toBe(1);

    // Leader announces a state vector that does NOT include the follower's
    // clock yet: buffer retained.
    const emptyVector = Y.encodeStateVector(new Y.Doc());
    room.onLeaderPersisted(emptyVector);
    expect(room.getBufferedCount()).toBe(1);

    // Leader flushes a document that contains the follower edit. Build a
    // vector covering the update's clocks.
    const covering = new Y.Doc();
    Y.applyUpdate(covering, bus.published[0].payload); // the follower's update
    room.onLeaderPersisted(Y.encodeStateVector(covering));
    expect(room.getBufferedCount()).toBe(0);
    expect(room.hasUnconfirmedLocalEdits()).toBe(false);
  });

  it('BUG2: bus updates arriving before a peer room exists are recovered via catch-up, not dropped', async () => {
    // RoomManager-level guarantee is covered by the integration suite; here
    // verify the room applies late sync-step2 catch-up data with bus origin.
    const bus = new ScriptedBus();
    const { room } = makeRoom(bus);
    await room.ensureLoaded(); // loaded empty from storage

    // Simulate a peer answering our startup sync-step1 with the missing edit.
    const source = new Y.Doc();
    source.getText('content').insert(0, 'late catch-up state');
    room.applyBusSyncStep2(Y.encodeStateAsUpdate(source));
    source.destroy();

    expect(room.doc.getText('content').toString()).toBe('late catch-up state');
  });

  it('persisted vectors also prune bus-origin entries on followers, but never local unconfirmed ones', async () => {
    const bus = new ScriptedBus();
    const { room } = makeRoom(bus);
    await room.ensureLoaded();

    // One local edit (follower) and one bus-relayed edit from a peer.
    const localDoc = new Y.Doc();
    localDoc.getText('content').insert(0, 'L');
    const localUpdate = Y.encodeStateAsUpdate(localDoc);
    const peerDoc = new Y.Doc();
    peerDoc.getText('content').insert(1, 'P');
    const peerUpdate = Y.encodeStateAsUpdate(peerDoc);

    await room.applyClientUpdate(localUpdate, {} as never);
    room.applyBusUpdate(peerUpdate);
    expect(room.bufferedOrigins().sort()).toEqual(['bus', 'local']);

    // Leader confirms only the peer clocks: bus entry pruned, local kept.
    const peerVectorDoc = new Y.Doc();
    Y.applyUpdate(peerVectorDoc, peerUpdate);
    room.onLeaderPersisted(Y.encodeStateVector(peerVectorDoc));
    expect(room.getBufferedCount()).toBe(1);
    expect(room.hasUnconfirmedLocalEdits()).toBe(true);
  });
});
