import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

/**
 * Wire protocol constants - these MUST match y-websocket / y-protocols.
 * See https://github.com/yjs/y-websocket/blob/master/src/y-websocket.js
 */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
/** y-websocket: a client asking for the room's current awareness state */
export const MESSAGE_QUERY_AWARENESS = 3;
/**
 * Custom message type for permission denial. y-websocket clients ignore
 * unknown message types; the frontend reads the frame via the raw socket to
 * surface the reason in a toast. Types 0-3 are used by y-websocket, so we
 * pick 4.
 */
export const MESSAGE_PERMISSION_DENIED = 4;

// sync sub-types (y-protocols/sync)
export const SYNC_STEP_1 = 0;
export const SYNC_STEP_2 = 1;
export const SYNC_UPDATE = 2;

/**
 * Answer a client's sync-step-1 (which carries its encoded state vector).
 * The client parses incoming sync frames as `[MESSAGE_SYNC, subtype, ...]`,
 * so we respond with an explicit SYNC_STEP_2 frame containing the update.
 */
export function buildSyncStep1Response(doc: Y.Doc, clientStateVector: Uint8Array): Uint8Array {
  // encodeStateAsUpdate accepts an encoded state vector directly.
  const update = Y.encodeStateAsUpdate(doc, clientStateVector);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, SYNC_STEP_2);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function buildSyncUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, SYNC_UPDATE);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function buildAwarenessUpdate(
  awareness: awarenessProtocol.Awareness,
  clientIds: number[],
): Uint8Array {
  const update = awarenessProtocol.encodeAwarenessUpdate(awareness, clientIds);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function buildPermissionDenied(reason: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_PERMISSION_DENIED);
  encoding.writeVarString(encoder, reason);
  return encoding.toUint8Array(encoder);
}

export function readMessageType(data: Uint8Array): {
  type: number;
  decoder: decoding.Decoder;
} {
  const decoder = decoding.createDecoder(data);
  const type = decoding.readVarUint(decoder);
  return { type, decoder };
}

export { encoding, decoding, syncProtocol, awarenessProtocol };
