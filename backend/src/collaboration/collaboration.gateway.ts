import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WebSocket, WebSocketServer } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import * as decoding from 'lib0/decoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import { PermissionService } from '../projects/permission.service';
import { ProjectRole } from '../projects/roles';
import { Room, RoomManager } from './room-manager';
import {
  buildAwarenessUpdate,
  buildPermissionDenied,
  MESSAGE_AWARENESS,
  MESSAGE_QUERY_AWARENESS,
  MESSAGE_SYNC,
  readMessageType,
  SYNC_STEP_1,
  SYNC_STEP_2,
  SYNC_UPDATE,
} from './collab.protocol';

interface AuthedSocket extends WebSocket {
  isAlive?: boolean;
}

interface ConnectionMeta {
  userId: string;
  name: string;
  color: string;
  role: ProjectRole;
  /** Yjs awareness client ids this websocket opened in this room */
  docClientIds: Set<number>;
}

/** Parse the client ids out of an encoded y-protocols awareness update. */
function readChangedClientIds(payload: Uint8Array): number[] {
  const decoder = decoding.createDecoder(payload);
  const len = decoding.readVarUint(decoder);
  const ids: number[] = [];
  for (let i = 0; i < len; i++) {
    const clientId = decoding.readVarUint(decoder);
    ids.push(clientId);
    // clock + (json state | null)
    decoding.readVarUint(decoder);
    const state = decoding.readVarString(decoder);
    void state;
  }
  return ids;
}

/**
 * Raw `ws` gateway implementing the y-websocket wire protocol.
 *
 * URL:  ws://host/collab/:documentId?token=<JWT>
 *
 * A separate gateway (instead of @nestjs/websockets) is used because the
 * protocol is binary and byte-compatible with the official y-websocket client.
 */
@Injectable()
export class CollaborationGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CollaborationGateway.name);
  private wss: WebSocketServer | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly jwt: JwtService,
    private readonly permissions: PermissionService,
    private readonly rooms: RoomManager,
  ) {}

  onModuleInit(): void {
    // Nothing yet; attach() is called from main.ts with the HTTP server.
  }

  attach(httpServer: HttpServer, path = '/collab'): void {
    this.wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head, path).catch((err) => {
        this.logger.error(`Upgrade error: ${(err as Error).message}`);
        try {
          socket.destroy();
        } catch {
          // already destroyed
        }
      });
    });

    // Heartbeat: terminate sockets that stopped responding.
    this.pingTimer = setInterval(() => {
      if (!this.wss) return;
      for (const ws of this.wss.clients) {
        const alive = (ws as AuthedSocket).isAlive;
        if (alive === false) {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          continue;
        }
        (ws as AuthedSocket).isAlive = false;
        try {
          ws.ping();
        } catch {
          // ignore
        }
      }
    }, 30_000);
    this.pingTimer.unref?.();
    this.logger.log(`Collaboration WebSocket attached at ${path}/:documentId`);
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    expectedPath: string,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '');

    // /collab/:documentId
    if (!pathname.startsWith(`${expectedPath}/`)) {
      return; // not ours; let other upgrade handlers deal with it
    }
    const documentId = decodeURIComponent(pathname.slice(expectedPath.length + 1));
    if (!documentId) {
      this.rejectUpgrade(socket, 400, 'Missing documentId');
      return;
    }

    // 1) Authenticate via ?token= (also support Authorization header).
    const token =
      url.searchParams.get('token') ??
      (request.headers.authorization?.startsWith('Bearer ')
        ? request.headers.authorization.slice(7)
        : null);
    if (!token) {
      this.rejectUpgrade(socket, 401, 'Missing token');
      return;
    }

    let user: { sub: string; name: string; color: string };
    try {
      user = this.jwt.verify<{ sub: string; name: string; color: string }>(token);
    } catch {
      this.rejectUpgrade(socket, 401, 'Invalid token');
      return;
    }

    // 2) Authorize: the room id is the File id.
    const access = await this.permissions.getFileRole(documentId, user.sub);
    if (!access) {
      this.rejectUpgrade(socket, 403, 'No access to this document');
      return;
    }

    this.wss!.handleUpgrade(request, socket, head, (ws) => {
      this.wss!.emit('connection', ws, {
        documentId,
        user,
        role: access.role,
      });
    });
  }

  private rejectUpgrade(socket: Duplex, status: number, message: string): void {
    try {
      socket.write(
        `HTTP/1.1 ${status} ${message}\r\n` +
          'Connection: close\r\n' +
          'Content-Type: text/plain\r\n' +
          `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n` +
          message,
      );
    } finally {
      socket.destroy();
    }
  }

  /** Called by the Nest bootstrap once the server is attached. */
  registerConnectionHandler(): void {
    if (!this.wss) throw new Error('Gateway not attached');
    this.wss.on(
      'connection',
      (ws: AuthedSocket, opts: {
        documentId: string;
        user: { sub: string; name: string; color: string };
        role: ProjectRole;
      }) => {
        void this.onConnection(ws, opts);
      },
    );
  }

  private async onConnection(
    ws: AuthedSocket,
    opts: {
      documentId: string;
      user: { sub: string; name: string; color: string };
      role: ProjectRole;
    },
  ): Promise<void> {
    const { documentId, user, role } = opts;
    ws.isAlive = true;

    let room: Room;
    try {
      room = await this.rooms.getOrCreate(documentId);
    } catch (err) {
      this.logger.error(
        `Failed to load room ${documentId}: ${(err as Error).message}`,
      );
      ws.close(1011, 'Failed to load document');
      return;
    }

    const conn: ConnectionMeta = {
      userId: user.sub,
      name: user.name,
      color: user.color,
      role,
      docClientIds: new Set(),
    };
    room.connections.set(ws, conn);
    room.touch();

    // Push current awareness (cursors/presence) to the newcomer.
    const states = room.awareness.getStates();
    if (states.size > 0) {
      ws.send(
        buildAwarenessUpdate(room.awareness, Array.from(states.keys())),
      );
    }

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data: Buffer) => {
      try {
        this.handleMessage(room, ws, conn, new Uint8Array(data), role);
      } catch (err) {
        this.logger.warn(
          `Bad message in room ${documentId}: ${(err as Error).message}`,
        );
      }
    });

    ws.on('close', () => {
      this.onDisconnect(room, ws, conn);
    });

    ws.on('error', (err) => {
      this.logger.debug(`Socket error: ${err.message}`);
    });
  }

  private handleMessage(
    room: Room,
    ws: AuthedSocket,
    conn: ConnectionMeta,
    data: Uint8Array,
    role: ProjectRole,
  ): void {
    const { type, decoder } = readMessageType(data);

    if (type === MESSAGE_SYNC) {
      const syncType = decoding.readVarUint(decoder);
      if (syncType === SYNC_STEP_1) {
        const clientStateVector = decoding.readVarUint8Array(decoder);
        // Viewers receive the document state but can never mutate it.
        ws.send(room.encodeSyncStep1Response(clientStateVector));
        return;
      }

      if (
        syncType === SYNC_STEP_2 ||
        syncType === SYNC_UPDATE
      ) {
        // Both step-2 responses and incremental updates carry a full Yjs
        // update; apply both identically when received from a client.
        const update = decoding.readVarUint8Array(decoder);
        if (role === 'viewer') {
          ws.send(
            buildPermissionDenied('Viewers cannot edit this document'),
          );
          return;
        }
        room.applyClientUpdate(update, ws);
        return;
      }
      return;
    }

    if (type === MESSAGE_QUERY_AWARENESS) {
      // y-websocket may explicitly ask for current awareness states.
      const ids = Array.from(room.awareness.getStates().keys());
      if (ids.length > 0) {
        ws.send(buildAwarenessUpdate(room.awareness, ids));
      }
      return;
    }

    if (type === MESSAGE_AWARENESS) {
      // y-websocket frame: [MESSAGE_AWARENESS][length-prefixed awareness update]
      const payload = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(
        room.awareness,
        payload,
        ws,
      );
      const addedClientIds = readChangedClientIds(payload);
      for (const id of addedClientIds) {
        const state = room.awareness.getStates().get(id);
        // Only track clients that actually carry user state (y-monaco peers).
        if (state) {
          conn.docClientIds.add(id);
          room.clientIdToSocket.set(id, ws);
        }
      }
      return;
    }
    // Unknown message types are ignored (forward-compatibility).
  }

  private onDisconnect(
    room: Room,
    ws: AuthedSocket,
    conn: ConnectionMeta,
  ): void {
    room.connections.delete(ws);
    const clientIds = Array.from(conn.docClientIds);
    if (clientIds.length > 0) {
      // Origin = the closing socket so it is not echoed back; awareness event
      // broadcasts removals to remaining participants and refreshes presence.
      awarenessProtocol.removeAwarenessStates(room.awareness, clientIds, ws);
      void room.recordDisconnectInPresence(clientIds);
      for (const id of clientIds) {
        room.clientIdToSocket.delete(id);
      }
    }
    room.touch();
    this.logger.log(
      `Client ${conn.userId} left room ${room.documentId} (${room.connections.size} remaining)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.wss) {
      for (const ws of this.wss.clients) {
        ws.terminate();
      }
    }
  }
}
