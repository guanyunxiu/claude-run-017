import { randomUUID } from 'crypto';
import { CollaborationBus } from './collaboration-bus';

/**
 * Default single-instance bus. Nothing crosses a process boundary:
 * subscribe/publish are no-ops and every lease is instantly acquirable, so
 * behaviour matches the phase-1 RoomManager exactly.
 */
export class LocalCollaborationBus extends CollaborationBus {
  readonly instanceId = `local-${randomUUID()}`;
  readonly enabled = false;
  private ownedLeases = new Set<string>();

  async start(): Promise<void> {
    /* noop */
  }
  async subscribe(_fileId: string): Promise<void> {}
  async unsubscribe(_fileId: string): Promise<void> {}
  async publishDocUpdate(_fileId: string, _update: Uint8Array): Promise<void> {}
  async publishAwareness(_fileId: string, _update: Uint8Array): Promise<void> {}
  async publishSyncStep1(_fileId: string, _sv: Uint8Array): Promise<void> {}
  async publishSyncStep2(
    _fileId: string,
    _update: Uint8Array,
    _target: string,
  ): Promise<void> {}
  async publishPersisted(_fileId: string, _stateVector: Uint8Array): Promise<void> {}
  async publishKick(_userId: string, _reason: string): Promise<void> {}

  async acquireLease(fileId: string): Promise<boolean> {
    this.ownedLeases.add(fileId);
    return true;
  }
  async renewLease(fileId: string): Promise<boolean> {
    return this.ownedLeases.has(fileId);
  }
  async releaseLease(fileId: string): Promise<void> {
    this.ownedLeases.delete(fileId);
  }

  async stop(): Promise<void> {}
}
