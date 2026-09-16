import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { CollaborationBus } from './collaboration-bus';
import { LocalCollaborationBus } from './local-collaboration-bus';
import { RedisCollaborationBus } from './redis-collaboration-bus';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

export const COLLAB_BUS = 'COLLAB_BUS';

/**
 * Selects the collaboration backplane from configuration:
 *   COLLAB_BUS=redis -> Redis pub/sub + lease-based single persistence leader
 *   COLLAB_BUS=local (default) -> in-process no-op bus (phase-1 behaviour)
 */
export const collaborationBusProvider: Provider = {
  provide: COLLAB_BUS,
  inject: [ConfigService, REDIS_CLIENT],
  useFactory: (config: ConfigService, redis: Redis): CollaborationBus => {
    const mode = config.get<string>('COLLAB_BUS', 'local').toLowerCase();
    if (mode === 'redis') {
      return new RedisCollaborationBus(redis);
    }
    return new LocalCollaborationBus();
  },
};
