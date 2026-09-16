import { Module } from '@nestjs/common';
import { CollaborationGateway } from './collaboration.gateway';
import { RoomManager } from './room-manager';
import { PresenceService } from './presence.service';
import { ProjectsModule } from '../projects/projects.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';

/**
 * RealtimeModule (global) supplies the CollaborationBus and LiveSessionService
 * singletons; this module provides the gateway, rooms and presence that use
 * them. ProjectsModule can inject the same LiveSessionService without a
 * projects <-> collaboration circular import.
 */
@Module({
  imports: [ProjectsModule, AuthModule, StorageModule],
  providers: [CollaborationGateway, RoomManager, PresenceService],
  exports: [CollaborationGateway, RoomManager, PresenceService],
})
export class CollaborationModule {}
