import { getToken } from './client';

/**
 * Build the y-websocket base URL. In dev the Vite proxy forwards /collab to
 * the backend; in Docker the nginx proxy does the same. We always use a
 * same-origin relative URL so no build-time env vars are required.
 */
export function collaborationUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/collab`;
}

export function collaborationQuery(): Record<string, string> {
  const token = getToken();
  return token ? { token } : {};
}
