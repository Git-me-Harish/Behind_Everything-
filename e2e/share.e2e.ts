import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/** Sharing a session as a file, opening one, and the first-run screen with its demo sessions. */

const list = (page: Page) => page.getByRole('navigation', { name: 'Sessions' });

test('share a session as a file, open it as a shared session, then remove it', async ({ page }) => {
  await page.goto('/');
  await list(page).getByRole('button', { name: /Fix the cart total/ }).click();
  await page.getByRole('region', { name: 'Session' }).getByRole('button', { name: 'Share' }).click();

  const dialog = page.getByRole('dialog', { name: 'Share this session' });
  const preview = dialog.getByRole('region', { name: 'What the file contains' });
  await expect(preview).toContainText(/\d+ events/);
  await expect(preview).toContainText('Never included');
  await dialog.getByLabel('Command and tool output').uncheck();
  await expect(preview).toContainText(/Left out: \d+ outputs/);

  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: /^Download/ }).click()]);
  expect(download.suggestedFilename()).toBe('fix-the-cart-total-rounding-bug.behind-everything.json');
  const file = await download.path();
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(bundle).toMatchObject({ format: 'behind-everything/session', options: { prompts: true, outputs: false, diffs: true } });
  expect(bundle.events.some((e: { payload?: object }) => e.payload && 'output' in e.payload)).toBe(false);
  expect(JSON.stringify(bundle)).not.toContain('C:\\\\work\\\\shop');
  await expect(page.locator('.notice')).toContainText('Saved fix-the-cart-total-rounding-bug.behind-everything.json');

  // Open it the way the person you sent it to would.
  await page.locator('input[type=file]').setInputFiles(file);
  await expect(page.locator('.notice')).toContainText('Opened');
  const header = page.getByRole('region', { name: 'Session' });
  await expect(header).toContainText('Shared session');
  await expect(header.getByRole('heading', { level: 1 })).toHaveText('Fix the cart total rounding bug');
  await expect(page).toHaveURL(/session=shared%3Acodex/);
  await expect(list(page).getByRole('button', { name: /Fix the cart total/ }).filter({ hasText: 'Shared' })).toBeVisible();
  await expect(page.getByRole('group', { name: /Workspace map/ })).toBeVisible();

  await header.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.notice')).toContainText('Removed the shared session');
  await expect(list(page).getByRole('button', { name: /Fix the cart total/ }).filter({ hasText: 'Shared' })).toHaveCount(0);
});

test('a file dropped on the window opens; a file that is not a session explains why', async ({ page }) => {
  await page.goto('/');
  const drop = async (name: string, text: string) => page.evaluate(([n, t]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([t!], n!, { type: 'application/json' }));
    window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, cancelable: true }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, cancelable: true }));
  }, [name, text]);
  await drop('notes.json', '{"hello": "world"}');
  await expect(page.locator('.notice.error')).toContainText('not a Behind Everything session file');
  const demo = await (await page.request.get('/demo-copilot-cli.json')).text();
  await drop('copilot.json', demo);
  await expect(page.locator('.notice')).toContainText('Opened copilot.json');
  await expect(page.getByRole('region', { name: 'Session' })).toContainText('Shared session');
  await page.getByRole('region', { name: 'Session' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.notice')).toContainText('Removed');
});

test('the first run explains what to do and opens a demo session for each assistant', async ({ page }) => {
  // A machine with no sessions yet.
  await page.route('**/api/sessions', r => r.fulfill({ json: [] }));
  await page.goto('/');
  const welcome = page.getByRole('region', { name: 'Welcome to Behind Everything' });
  await expect(welcome).toBeVisible();
  await expect(welcome.getByRole('list', { name: 'Assistants on this machine' }).getByRole('listitem')).toHaveCount(3);
  await expect(welcome).toContainText('Claude Code');
  await expect(welcome).toContainText('npx behind-everything doctor');

  await page.unroute('**/api/sessions');
  await welcome.getByRole('button', { name: 'Explore the demo sessions' }).click();
  await expect(page.locator('.notice')).toContainText('Opened three demo sessions');
  await expect(page.getByRole('region', { name: 'Session' })).toContainText('Shared session');
  for (const title of [/Fix date parser/, /Fix the cart total/, /Add tags to notes/]) {
    await expect(list(page).getByRole('button', { name: title }).filter({ hasText: 'Shared' })).toHaveCount(1);
  }
  // Leave the shared environment as it was for the other tests.
  for (const s of await (await page.request.get('/api/sessions')).json() as Array<{ id: string }>) {
    if (s.id.startsWith('shared:')) expect((await page.request.delete(`/api/sessions/${encodeURIComponent(s.id)}`)).ok()).toBe(true);
  }
});
