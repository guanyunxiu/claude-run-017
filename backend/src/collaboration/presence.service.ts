import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT } from '../common/redis/redis.module';

export interface PresenceUser {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  /** Yjs cursor/selection metadata shared through awareness */
  cursor?: unknown;
  /** epoch ms of last presence update */
  lastSeen: number;
}

const PRESENCE_PREFIX = 'presence:doc:';

/**
 * Online presence backed by Redis.
 *
 * For every open document we keep one Redis HASH:
 *   presence:doc:<documentId>
 *     field: Yjs awareness clientId (string)
 *     value: JSON-serialized PresenceUser
 *
 * Each write refreshes a TTL so a crashed backend / dropped websocket does not
 * leave ghosts forever. Multiple backend instances see the same room state.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);
  private readonly ttlSeconds: number;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.ttlSeconds = config.get<number>('PRESENCE_TTL_SECONDS', 30);
  }

  private key(documentId: string): string {
    return `${PRESENCE_PREFIX}${documentId}`;
  }

  async heartbeat(documentId: string, user: PresenceUser): Promise<void> {
    await this.redis.hset(this.key(documentId), String(user.clientId), JSON.stringify(user));
    await this.redis.expire(this.key(documentId), this.ttlSeconds);
  }

  async remove(documentId: string, clientId: number): Promise<void> {
    await this.redis.hdel(this.key(documentId), String(clientId));
  }

  async list(documentId: string): Promise<PresenceUser[]> {
    const raw = await this.redis.hgetall(this.key(documentId));
    const now = Date.now();
    const stale: string[] = [];
    const users = Object.entries(raw)
      .map(([clientId, value]) => {
        try {
          const parsed = JSON.parse(value) as PresenceUser;
          if (now - parsed.lastSeen > this.ttlSeconds * 1000) {
            stale.push(clientId);
            return null;
          }
          return parsed;
        } catch {
          stale.push(clientId);
          return null;
        }
      })
      .filter((u): u is PresenceUser => u !== null);

    if (stale.length > 0) {
      void this.redis.hdel(this.key(documentId), ...stale).catch(() => undefined);
    }
    return users;
  }

  async count(documentId: string): Promise<number> {
    return this.redis.hlen(this.key(documentId));
  }
}
