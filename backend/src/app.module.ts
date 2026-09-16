import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { ProjectsModule } from './projects/projects.module';
import { FilesModule } from './files/files.module';
import { CollaborationModule } from './collaboration/collaboration.module';
import { RealtimeModule } from './collaboration/realtime.module';
import { StorageModule } from './storage/storage.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    RedisModule,
    StorageModule,
    RealtimeModule,
    AuthModule,
    ProjectsModule,
    FilesModule,
    CollaborationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
