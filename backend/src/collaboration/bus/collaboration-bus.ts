/**
 * Cross-instance collaboration backplane ("bus").
 *
 * In single-instance deployments the no-op {@link LocalCollaborationBus} is
 * used and behaviour is identical to phase 1. When COLLAB_BUS=redis every
 * backend instance participates in Redis pub/sub per document, so a client
 * connected to instance A and one connected to instance B converge in real
 * time while only the elected persistence leader writes to Postgres/S3.
 *
 * Document channels (one per file, carrying every message kind):
 *   collab:doc:<fileId>
 *
 * Kick channel (one shared pattern subscription, per-user events):
 *   collab:kick:<userId>        payload = plain UTF-8 reason
 *
 * Persistence lease (single writer per document):
 *   collab:lock:doc:<fileId>   value = instanceId, TTL = leaseMs
 */

export type BusMessageKind =
  | 'doc-update'
  | 'awareness'
  | 'sync-step1'
  | 'sync-step2'
  | 'persisted';

export interface BusMessageHeader {
  /** sending instance id */
  i: string;
  /** for targeted replies (sync-step2): destination instance id */
  t?: string;
}

export interface BusHandlers {
  onDocUpdate(fileId: string, update: Uint8Array, fromInstance: string): void;
  onAwareness(fileId: string, update: Uint8Array, fromInstance: string): void;
  /** A peer requests the current document state (state vector included). */
  onSyncStep1(
    fileId: string,
    stateVector: Uint8Array,
    fromInstance: string,
  ): void;
  /** Targeted response to a previous sync-step1. */
  onSyncStep2(
    fileId: string,
    update: Uint8Array,
    targetInstance: string,
    fromInstance: string,
  ): void;
  /**
   * Leader broadcast after a successful flush. Payload is the leader's Yjs
   * state vector; followers use it to confirm their locally-originated
   * updates are durable and to prune their safety buffers.
   */
  onPersisted(fileId: string, stateVector: Uint8Array, fromInstance: string): void;
}

/**
 * Callbacks for access/control events that are not document scoped. Kept
 * separate from BusHandlers because kick subscriptions are global.
 */
export interface BusControlHandlers {
  /** A user was kicked (removed from a project); close their live sockets. */
  onKick(userId: string, reason: string, fromInstance: string): void;
}

export abstract class CollaborationBus {
  abstract readonly instanceId: string;
  /** false for the single-instance no-op bus */
  abstract readonly enabled: boolean;

  protected handlers: BusHandlers | null = null;
  protected controlHandlers: BusControlHandlers | null = null;

  /** Register message handlers. Called once by the RoomManager. */
  attachHandlers(handlers: BusHandlers): void {
    this.handlers = handlers;
  }

  attachControlHandlers(handlers: BusControlHandlers): void {
    this.controlHandlers = handlers;
  }

  protected get h(): BusHandlers | null {
    return this.handlers;
  }

  protected dispatch(
    kind: BusMessageKind,
    fileId: string,
    payload: Uint8Array,
    header: BusMessageHeader,
  ): void {
    if (!this.handlers) return;
    switch (kind) {
      case 'doc-update':
        this.handlers.onDocUpdate(fileId, payload, header.i);
        break;
      case 'awareness':
        this.handlers.onAwareness(fileId, payload, header.i);
        break;
      case 'sync-step1':
        this.handlers.onSyncStep1(fileId, payload, header.i);
        break;
      case 'sync-step2':
        this.handlers.onSyncStep2(fileId, payload, header.t ?? '', header.i);
        break;
      case 'persisted':
        this.handlers.onPersisted(fileId, payload, header.i);
        break;
    }
  }

  /** Open publisher/subscriber connections (redis) and wire message parsing. */
  abstract start(): Promise<void>;

  abstract subscribe(fileId: string): Promise<void>;
  abstract unsubscribe(fileId: string): Promise<void>;

  abstract publishDocUpdate(fileId: string, update: Uint8Array): Promise<void>;
  abstract publishAwareness(fileId: string, update: Uint8Array): Promise<void>;
  abstract publishSyncStep1(
    fileId: string,
    stateVector: Uint8Array,
  ): Promise<void>;
  abstract publishSyncStep2(
    fileId: string,
    update: Uint8Array,
    targetInstance: string,
  ): Promise<void>;
  /** Broadcast that the leader durably flushed up to this state vector. */
  abstract publishPersisted(fileId: string, stateVector: Uint8Array): Promise<void>;

  /**
   * Tell every instance (including this one's peer services) to close all
   * live sockets belonging to `userId`. Used when a member is removed from a
   * project. No-op on the single-instance bus (the caller closes locally).
   */
  abstract publishKick(userId: string, reason: string): Promise<void>;

  /**
   * Try to acquire (or renew when already owned) the persistence lease.
   * Returns true iff this instance currently owns the lease.
   */
  abstract acquireLease(fileId: string, ttlMs: number): Promise<boolean>;
  /** Renew only when the lease is currently owned by this instance. */
  abstract renewLease(fileId: string, ttlMs: number): Promise<boolean>;
  abstract releaseLease(fileId: string): Promise<void>;

  abstract stop(): Promise<void>;
}

export function docChannel(fileId: string): string {
  return `collab:doc:${fileId}`;
}

export function kickChannel(userId: string): string {
  return `collab:kick:${userId}`;
}

export const KICK_PATTERN = 'collab:kick:*';

export function lockKey(fileId: string): string {
  return `collab:lock:doc:${fileId}`;
}

// ---------------------------------------------------------------------------
// Wire framing for redis pub/sub payloads:
//   [kind:1][headerLen:4 BE][header JSON UTF-8][payload bytes]
// ---------------------------------------------------------------------------

const KIND_CODES: Record<BusMessageKind, number> = {
  'doc-update': 1,
  awareness: 2,
  'sync-step1': 3,
  'sync-step2': 4,
  persisted: 5,
};
const CODE_KINDS: Record<number, BusMessageKind> = Object.fromEntries(
  Object.entries(KIND_CODES).map(([k, v]) => [v, k as BusMessageKind]),
);

export function encodeBusMessage(
  kind: BusMessageKind,
  payload: Uint8Array,
  header: BusMessageHeader,
): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const buf = Buffer.allocUnsafe(5 + headerBytes.length + payload.byteLength);
  buf.writeUInt8(KIND_CODES[kind], 0);
  buf.writeUInt32BE(headerBytes.length, 1);
  headerBytes.copy(buf, 5);
  Buffer.from(payload).copy(buf, 5 + headerBytes.length);
  return buf;
}

export function decodeBusMessage(raw: Buffer | Uint8Array): {
  kind: BusMessageKind;
  header: BusMessageHeader;
  payload: Uint8Array;
} {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.length < 5) throw new Error('bus message too short');
  const kind = CODE_KINDS[buf.readUInt8(0)];
  if (!kind) throw new Error(`unknown bus message kind ${buf.readUInt8(0)}`);
  const headerLen = buf.readUInt32BE(1);
  const header = JSON.parse(
    buf.subarray(5, 5 + headerLen).toString('utf8'),
  ) as BusMessageHeader;
  const payload = new Uint8Array(
    buf.buffer,
    buf.byteOffset + 5 + headerLen,
    buf.length - 5 - headerLen,
  );
  return { kind, header, payload };
}
