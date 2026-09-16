import { Module } from '@nestjs/common';
import { CollaborationGateway } from './collaboration.gateway';
import { RoomManager } from './room-manager';
import { PresenceService } from './presence.service';
import { collaborationBusProvider, COLLAB_BUS } from './bus/collaboration-bus.provider';
import { ProjectsModule } from '../projects/projects.module';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [ProjectsModule, AuthModule, StorageModule],
  providers: [
    collaborationBusProvider,
    CollaborationGateway,
    RoomManager,
    PresenceService,
  ],
  exports: [CollaborationGateway, RoomManager, PresenceService, COLLAB_BUS],
})
export class CollaborationModule {}
