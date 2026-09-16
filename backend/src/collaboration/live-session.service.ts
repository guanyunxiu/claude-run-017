import { Inject, Injectable, Logger } from '@nestjs/common';
import type { WebSocket } from 'ws';
import { CollaborationBus } from './bus/collaboration-bus';
import { COLLAB_BUS } from './bus/collaboration-bus.provider';

/**
 * Tracks the live WebSockets belonging to a user across all rooms on THIS
 * instance and coordinates cross-instance access revocation.
 *
 * A single service (rather than logic spread over gateway + projects) keeps
 * member removal in the REST layer able to disconnect active collaborators
 * without importing the whole CollaborationModule (which itself depends on
 * ProjectsModule for authorization).
 */
@Injectable()
export class LiveSessionService {
  private readonly logger = new Logger(LiveSessionService.name);
  private readonly socketsByUser = new Map<string, Set<WebSocket>>();

  constructor(@Inject(COLLAB_BUS) private readonly bus: CollaborationBus) {
    // Any OTHER instance removing this user notifies us via the bus; close
    // sockets this instance is holding. The originating instance closes its
    // own sockets directly (publishKick never echoes back).
    this.bus.attachControlHandlers({
      onKick: (userId, reason) => {
        const n = this.kickLocal(userId, reason);
        if (n > 0) {
          this.logger.log(
            `Closed ${n} local socket(s) for kicked user ${userId}`,
          );
        }
      },
    });
  }

  register(userId: string, ws: WebSocket): void {
    let set = this.socketsByUser.get(userId);
    if (!set) {
      set = new Set();
      this.socketsByUser.set(userId, set);
    }
    set.add(ws);
  }

  unregister(userId: string, ws: WebSocket): void {
    const set = this.socketsByUser.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.socketsByUser.delete(userId);
  }

  count(userId: string): number {
    return this.socketsByUser.get(userId)?.size ?? 0;
  }

  /**
   * Revoke a user's live access: close local sockets immediately and notify
   * every other backend. Called when a member is removed from a project.
   */
  async kick(userId: string, reason: string): Promise<number> {
    const localCount = this.kickLocal(userId, reason);
    if (this.bus.enabled) {
      await this.bus.publishKick(userId, reason);
    }
    return localCount;
  }

  /** Close only sockets held by this instance. */
  private kickLocal(userId: string, reason: string): number {
    const set = this.socketsByUser.get(userId);
    if (!set || set.size === 0) return 0;
    const sockets = [...set];
    this.socketsByUser.delete(userId);
    for (const ws of sockets) {
      try {
        // 1008 = policy violation. The frontend treats it as "access
        // revoked" and stops auto-reconnecting for that document.
        ws.close(1008, reason);
      } catch (err) {
        this.logger.warn(`kick close failed: ${(err as Error).message}`);
      }
    }
    return sockets.length;
  }
}
