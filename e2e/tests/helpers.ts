import { request } from '@playwright/test';

export interface ApiContext {
  user: { id: string; email: string; name: string; color: string };
  token: string;
  projectId: string;
  fileId: string;
}

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  try {
    const res = await ctx.fetch(`/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      data: body,
    });
    if (!res.ok()) {
      throw new Error(`${method} ${path} -> ${res.status()}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  } finally {
    await ctx.dispose();
  }
}

async function register(email: string, name: string, password: string) {
  return call<{ token: string; user: ApiContext['user'] }>(
    'POST',
    '/auth/register',
    { email, name, password },
  );
}

/**
 * Creates three users (owner/editor/viewer), a project, a TypeScript file and
 * the project memberships via the REST API so the browser scenarios can focus
 * purely on realtime collaboration behaviour.
 */
export async function setupFixture(): Promise<{
  owner: ApiContext;
  editor: { user: ApiContext['user']; token: string };
  viewer: { user: ApiContext['user']; token: string };
  password: string;
}> {
  const password = 'password123';
  const ownerAuth = await register(uniqueEmail('owner'), 'Olivia Owner', password);
  const editorAuth = await register(uniqueEmail('editor'), 'Evan Editor', password);
  const viewerAuth = await register(uniqueEmail('viewer'), 'Vera Viewer', password);

  const project = await call<{ id: string }>(
    'POST',
    '/projects',
    { name: `E2E Project ${Date.now()}` },
    ownerAuth.token,
  );

  await call(
    'POST',
    `/projects/${project.id}/members`,
    { email: editorAuth.user.email, role: 'editor' },
    ownerAuth.token,
  );
  await call(
    'POST',
    `/projects/${project.id}/members`,
    { email: viewerAuth.user.email, role: 'viewer' },
    ownerAuth.token,
  );

  const file = await call<{ id: string }>(
    'POST',
    `/projects/${project.id}/files`,
    { name: 'main.ts', path: 'src' },
    ownerAuth.token,
  );

  return {
    owner: {
      user: ownerAuth.user,
      token: ownerAuth.token,
      projectId: project.id,
      fileId: file.id,
    },
    editor: { user: editorAuth.user, token: editorAuth.token },
    viewer: { user: viewerAuth.user, token: viewerAuth.token },
    password,
  };
}

/** REST login used to bootstrap browser-independent sessions. */
export async function login(email: string, password: string) {
  return call<{ token: string; user: ApiContext['user'] }>(
    'POST',
    '/auth/login',
    { email, password },
  );
}

export async function readFileContent(fileId: string, token: string) {
  return call<{ content: string; language: string }>(
    'GET',
    `/files/${fileId}/content`,
    undefined,
    token,
  );
}

export async function waitForBackendReady(maxAttempts = 60): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Backend at ${BASE_URL} never became ready`);
}
