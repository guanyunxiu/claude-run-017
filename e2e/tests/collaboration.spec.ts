import { test, expect, type Page } from '@playwright/test';
import {
  readFileContent,
  setupFixture,
  waitForBackendReady,
  type ApiContext,
} from './helpers';

const EDIT_TIMEOUT = 15_000;

async function loginAs(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/projects\/|\/$/);
}

async function openProjectFile(
  page: Page,
  projectId: string,
  fileId: string,
) {
  await page.goto(`/projects/${projectId}`);
  await page.getByTestId(`file-tree-item-${fileId}`).click();
  await expect(page.getByTestId('monaco-host')).toBeVisible();
  await expect(page.getByTestId('connection-status')).toContainText(
    /Connected|Connecting/,
  );
}

/**
 * Focus Monaco and type via the real keyboard so the change flows through
 * Monaco -> y-monaco -> Y.Doc -> websocket exactly like a human keystroke.
 */
async function typeIntoMonaco(page: Page, text: string) {
  const editor = page.getByTestId('monaco-host');
  await editor.click();
  await page.waitForTimeout(150);
  // Clear existing content (Ctrl+A / Backspace).
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(200);
}

async function getMonacoText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as {
      monaco?: {
        editor: {
          getEditors: () => Array<{
            getModel: () => { getValue: () => string } | null;
          }>;
        };
      };
    };
    const model = w.monaco?.editor.getEditors()[0]?.getModel();
    if (!model) throw new Error('Monaco model not available');
    return model.getValue();
  });
}

async function waitForMonacoText(
  page: Page,
  predicate: (value: string) => boolean,
  timeout = 10_000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const value = await getMonacoText(page);
    if (predicate(value)) return;
    if (Date.now() - start > timeout) {
      throw new Error(`Monaco text never matched predicate. Last: ${JSON.stringify(value)}`);
    }
    await page.waitForTimeout(250);
  }
}

let fixture: Awaited<ReturnType<typeof setupFixture>>;

test.beforeAll(async () => {
  await waitForBackendReady();
  fixture = await setupFixture();
});

test.describe.configure({ mode: 'serial' });

test('registration, login and current user works in the browser', async ({
  page,
}) => {
  const email = `browser-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByTestId('register-name').fill('Browser User');
  await page.getByTestId('register-email').fill(email);
  await page.getByTestId('register-password').fill('password123');
  await page.getByTestId('register-submit').click();
  await page.waitForURL('/');
  await expect(page.getByText('Browser User').first()).toBeVisible();

  // JWT survives reload via /auth/me bootstrap.
  await page.reload();
  await expect(page.getByText('Browser User').first()).toBeVisible();
});

test('two browsers editing the same file converge in real time', async ({
  browser,
}) => {
  const ownerCtx = await browser.newContext();
  const editorCtx = await browser.newContext();
  const ownerPage = await ownerCtx.newPage();
  const editorPage = await editorCtx.newPage();

  await loginAs(
    ownerPage,
    fixture.owner.user.email,
    fixture.password,
  );
  await loginAs(
    editorPage,
    fixture.editor.user.email,
    fixture.password,
  );

  await openProjectFile(ownerPage, fixture.owner.projectId, fixture.owner.fileId);
  await openProjectFile(editorPage, fixture.owner.projectId, fixture.owner.fileId);

  // Both reach "Connected".
  await expect(ownerPage.getByTestId('connection-status')).toContainText(
    'Connected',
  );
  await expect(editorPage.getByTestId('connection-status')).toContainText(
    'Connected',
  );

  // Each browser sees the other user in the presence list.
  await expect(
    ownerPage.getByTestId('presence-list').getByTitle(/Evan Editor/),
  ).toBeVisible();
  await expect(
    editorPage.getByTestId('presence-list').getByTitle(/Olivia Owner/),
  ).toBeVisible();

  // Owner types first line -> editor sees it live.
  const ownerLine = `owner was here ${Date.now()}`;
  await typeIntoMonaco(ownerPage, `${ownerLine}\n`);
  await waitForMonacoText(editorPage, (v) => v.startsWith(ownerLine), EDIT_TIMEOUT);

  // Editor appends on the second line -> owner converges.
  const editorLine = `editor reply ${Date.now()}`;
  await typeIntoMonaco(editorPage, `${ownerLine}\n${editorLine}\n`);
  await waitForMonacoText(
    ownerPage,
    (v) => v.includes(ownerLine) && v.includes(editorLine),
    EDIT_TIMEOUT,
  );

  // Autosave: server eventually persists the merged content.
  await expect
    .poll(
      async () => (await readFileContent(fixture.owner.fileId, fixture.owner.token)).content,
      { timeout: 20_000, intervals: [1_000] },
    )
    .toContain(editorLine);

  await ownerCtx.close();
  await editorCtx.close();
});

test('a viewer sees live edits but cannot modify the file', async ({
  browser,
}) => {
  const ownerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const ownerPage = await ownerCtx.newPage();
  const viewerPage = await viewerCtx.newPage();

  await loginAs(ownerPage, fixture.owner.user.email, fixture.password);
  await loginAs(viewerPage, fixture.viewer.user.email, fixture.password);

  await openProjectFile(ownerPage, fixture.owner.projectId, fixture.owner.fileId);
  await openProjectFile(viewerPage, fixture.owner.projectId, fixture.owner.fileId);

  // Viewer UI is read-only.
  await expect(viewerPage.getByTestId('readonly-note')).toBeVisible();
  const viewerCanType = await viewerPage.evaluate(() => {
    const w = window as unknown as {
      monaco?: {
        editor: {
          getEditors: () => Array<{ getOption: (o: number) => boolean }>;
          EditorOption: { readOnly: number };
        };
      };
    };
    const editor = w.monaco?.editor.getEditors()[0];
    return editor?.getOption(w.monaco!.editor.EditorOption.readOnly) ?? false;
  });
  expect(viewerCanType).toBe(true);

  // Viewer cannot create/rename/delete files in the UI.
  await expect(viewerPage.getByTestId('new-file-button')).toHaveCount(0);

  // Viewer follows the owner's live edits.
  const liveMarker = `live-view ${Date.now()}`;
  const before = await getMonacoText(viewerPage);
  await typeIntoMonaco(ownerPage, `${before}${liveMarker}\n`);
  await waitForMonacoText(viewerPage, (v) => v.includes(liveMarker), EDIT_TIMEOUT);

  await ownerCtx.close();
  await viewerCtx.close();
});

test('viewer REST writes are rejected by the backend', async ({ request }) => {
  const res = await request.post(
    `/api/projects/${fixture.owner.projectId}/files`,
    {
      headers: { Authorization: `Bearer ${fixture.viewer.token}` },
      data: { name: 'hack.ts' },
    },
  );
  expect(res.status()).toBe(403);
});

// Ensure ApiContext type import is treated as used by tsc.
export type { ApiContext };
