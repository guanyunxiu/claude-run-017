import * as Y from 'yjs';
import {
  decodeBusMessage,
  encodeBusMessage,
  type BusMessageHeader,
} from './collaboration-bus';

describe('collaboration bus framing', () => {
  const kinds = ['doc-update', 'awareness', 'sync-step1', 'sync-step2'] as const;

  it.each(kinds)('round-trips kind "%s" with header and binary payload', (kind) => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, `payload for ${kind}`);
    const payload = Y.encodeStateAsUpdate(doc);
    const header: BusMessageHeader = { i: 'be-1', ...(kind === 'sync-step2' ? { t: 'be-2' } : {}) };

    const frame = encodeBusMessage(kind, payload, header);
    const decoded = decodeBusMessage(frame);

    expect(decoded.kind).toBe(kind);
    expect(decoded.header).toEqual(header);

    const replayed = new Y.Doc();
    Y.applyUpdate(replayed, decoded.payload);
    expect(replayed.getText('content').toString()).toBe(`payload for ${kind}`);
  });

  it('round-trips a unicode awareness header string', () => {
    const frame = encodeBusMessage(
      'awareness',
      new Uint8Array([0, 1, 2, 255]),
      { i: '实例-😊' },
    );
    const decoded = decodeBusMessage(frame);
    expect(decoded.header.i).toBe('实例-😊');
    expect(Array.from(decoded.payload)).toEqual([0, 1, 2, 255]);
  });

  it('rejects malformed frames', () => {
    expect(() => decodeBusMessage(Buffer.from([99, 0, 0, 0, 0]))).toThrow();
    expect(() => decodeBusMessage(Buffer.from([1]))).toThrow(/too short/);
  });
});
