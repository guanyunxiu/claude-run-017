import { Module } from '@nestjs/common';
import { CollaborationGateway } from './collaboration.gateway';
import { RoomManager } from './room-manager';
import { PresenceService } from './presence.service';
import { ProjectsModule } from '../projects/projects.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { FileVersionService } from './file-version.service';
import { FileVersionController } from './file-version.controller';

/**
 * RealtimeModule (global) supplies the CollaborationBus and LiveSessionService
 * singletons; this module provides the gateway, rooms, presence and file
 * version history that use them. ProjectsModule can inject LiveSessionService
 * without a projects <-> collaboration circular import.
 */
@Module({
  imports: [ProjectsModule, AuthModule, StorageModule],
  controllers: [FileVersionController],
  providers: [
    CollaborationGateway,
    RoomManager,
    PresenceService,
    FileVersionService,
  ],
  exports: [
    CollaborationGateway,
    RoomManager,
    PresenceService,
    FileVersionService,
  ],
})
export class CollaborationModule {}
