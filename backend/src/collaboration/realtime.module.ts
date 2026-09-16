import { Global, Module } from '@nestjs/common';
import { collaborationBusProvider, COLLAB_BUS } from './bus/collaboration-bus.provider';
import { LiveSessionService } from './live-session.service';

/**
 * Globally available realtime plumbing shared between the collaboration
 * module (gateway/rooms) and unrelated features that must affect live
 * sessions - currently project member removal kicking open sockets.
 * Keeping this in its own global module avoids a projects <-> collaboration
 * circular dependency.
 */
@Global()
@Module({
  providers: [collaborationBusProvider, LiveSessionService],
  exports: [COLLAB_BUS, LiveSessionService],
})
export class RealtimeModule {}
