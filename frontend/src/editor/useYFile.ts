import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { collaborationQuery, collaborationUrl } from '../api/ws';
import type {
  ConnectionStatus,
  PresenceUser,
  SaveStatus,
  User,
} from '../types';

interface Options {
  fileId: string;
  currentUser: User;
  onPermissionDenied?: (reason: string) => void;
}

interface ServerAwarenessState {
  server?: { savedAt?: number; documentId?: string };
  user?: { id: string; name: string; color: string };
}

/**
 * Owns the Yjs document + websocket provider lifecycle for one open file.
 * Reconnect is handled internally by y-websocket (exponential backoff).
 */
export function useYFile({
  fileId,
  currentUser,
  onPermissionDenied,
}: Options) {
  const docRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [synced, setSynced] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [presentUsers, setPresentUsers] = useState<PresenceUser[]>([]);

  // Stable refs for callbacks to avoid recreating the provider.
  const callbacksRef = useRef({ onPermissionDenied });
  callbacksRef.current = { onPermissionDenied };
  const lastDenialAt = useRef(0);

  useEffect(() => {
    const doc = new Y.Doc();
    docRef.current = doc;
    setSynced(false);
    setConnection('connecting');
    setSaveStatus('idle');
    setPresentUsers([]);

    const provider = new WebsocketProvider(
      collaborationUrl(),
      fileId,
      doc,
      {
        params: collaborationQuery(),
        connect: true,
        // Keep retrying reconnects forever; y-websocket backsoff automatically.
        maxBackoffTime: 10000,
      },
    );
    providerRef.current = provider;
    setYdoc(doc);
    setProvider(provider);

    provider.awareness.setLocalStateField('user', {
      id: currentUser.id,
      name: currentUser.name,
      color: currentUser.color,
    });

    const handleStatus = (event: {
      status: 'connected' | 'disconnected' | 'connecting';
    }) => {
      setConnection(
        event.status === 'connected'
          ? 'connected'
          : event.status === 'connecting'
            ? 'connecting'
            : 'disconnected',
      );
    };
    const handleSync = (syncedNow: boolean) => {
      setSynced(syncedNow);
    };
    const handleConnectionError = () => {
      setConnection('disconnected');
    };

    provider.on('status', handleStatus);
    provider.on('sync', handleSync);
    provider.on('connection-error', handleConnectionError);

    // Listen for our custom permission-denied frames (message type 4).
    // Decode lib0 varUint + varString so we do not need a second lib0 import.
    const rawMessageListener = (event: Event) => {
      const data = (event as MessageEvent<ArrayBuffer>).data;
      if (!data) return;
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data as ArrayBuffer);
      let pos = 0;
      const readVarUint = () => {
        let value = 0;
        let shift = 0;
        do {
          const b = bytes[pos++];
          value |= (b & 0x7f) << shift;
          shift += 7;
          if (b < 0x80) break;
        } while (pos < bytes.length);
        return value >>> 0;
      };
      const type = readVarUint();
      if (type === 4) {
        const byteLen = readVarUint();
        try {
          const reason = new TextDecoder().decode(
            bytes.subarray(pos, pos + byteLen),
          );
          // Viewers holding down a key would otherwise generate a toast per
          // frame; collapse identical denials to one every few seconds.
          const now = Date.now();
          if (now - lastDenialAt.current > 4000) {
            lastDenialAt.current = now;
            callbacksRef.current.onPermissionDenied?.(
              reason || 'You do not have permission to edit this file',
            );
          }
        } catch {
          /* malformed frame - ignore */
        }
      }
    };
    // Attach the raw frame listener to the (possibly reconnecting) socket.
    const attachedSockets = new WeakSet<object>();
    const attachRaw = setInterval(() => {
      const currentWs = provider.ws;
      if (currentWs && !attachedSockets.has(currentWs)) {
        attachedSockets.add(currentWs);
        currentWs.addEventListener('message', rawMessageListener as EventListener);
      }
    }, 50);

    // Presence + saved-at derivation from awareness states.
    const updatePresentUsers = () => {
      const states = Array.from(
        provider.awareness.getStates().entries(),
      ) as Array<[number, ServerAwarenessState]>;
      const users = new Map<string, PresenceUser>();
      let newestSavedAt: number | null = null;
      for (const [clientId, state] of states) {
        if (state.server?.savedAt) {
          newestSavedAt =
            newestSavedAt === null
              ? state.server.savedAt
              : Math.max(newestSavedAt, state.server.savedAt);
        }
        if (state.user) {
          users.set(`${clientId}:${state.user.id}`, {
            clientId,
            userId: state.user.id,
            name: state.user.name,
            color: state.user.color,
          });
        }
      }
      setPresentUsers(Array.from(users.values()));
      if (newestSavedAt !== null) {
        setLastSavedAt(newestSavedAt);
        setSaveStatus('saved');
      }
    };
    provider.awareness.on('change', updatePresentUsers);
    updatePresentUsers();

    // Local edit -> "saving" until the next server savedAt awareness tick.
    const text = doc.getText('content');
    const onLocalChange = () => {
      setSaveStatus((prev) => (prev === 'saved' || prev === 'idle' ? 'saving' : prev));
    };
    text.observe(onLocalChange);

    return () => {
      clearInterval(attachRaw);
      provider.off('status', handleStatus);
      provider.off('sync', handleSync);
      provider.off('connection-error', handleConnectionError);
      provider.awareness.off('change', updatePresentUsers);
      text.unobserve(onLocalChange);
      try {
        if (provider.ws) {
          provider.ws.removeEventListener('message', rawMessageListener);
        }
      } catch {
        // ignore
      }
      provider.destroy();
      doc.destroy();
      docRef.current = null;
      providerRef.current = null;
      setYdoc(null);
      setProvider(null);
    };
  }, [fileId, currentUser.id, currentUser.name, currentUser.color]);

  const forceReconnect = useCallback(() => {
    providerRef.current?.connect();
  }, []);

  return {
    ydoc,
    provider,
    connection,
    synced,
    saveStatus,
    lastSavedAt,
    presentUsers,
    forceReconnect,
  };
}
