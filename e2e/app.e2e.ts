import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { LIVE_TAIL, TRANSCRIPT } from '../playwright.config.ts';
import { demoSession } from '../test/fixtures/claude.ts';

test.describe.configure({ mode: 'serial' });

let page: Page;
const errors: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto('/');
});

test.afterAll(() => {
  expect(errors, 'browser console errors').toEqual([]);
});

const timeline = () => page.getByRole('listbox', { name: 'Session timeline' });
const zone = (name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) });

test('shows the session overview built from the transcript', async () => {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('demo');
  await expect(page.getByRole('navigation', { name: 'Sessions' }).getByRole('button')).toHaveCount(3) // the Claude demo, the Codex one and the Copilot one;
  await expect(zone('Test & Build Lab')).toContainText('TESTS 1✓ 1✗');
  await expect(zone('Implementation')).toContainText('1 FILE · +3 −2');
  await expect(zone('Repair Bay')).toContainText('~ 1 FIXED');
  // The blocked command's result is among the withheld live lines.
  await expect(zone('Approval Gate')).toContainText('1 APPROVED · 0 BLOCKED');
  await expect(timeline().getByText('Fix the failing date parser')).toBeVisible();
  await expect(page.getByText('Reasoning · 2.3s')).toBeVisible();
});

test('drills into an edit and shows its diff and evidence', async () => {
  await page.getByRole('button', { name: 'Edits', exact: true }).click();
  await timeline().getByRole('option').first().click();
  const details = page.getByRole('complementary', { name: 'Details' });
  await expect(details.getByRole('heading')).toHaveText('Edit src/date.ts');
  const diff = details.getByRole('region', { name: 'Diff' });
  await expect(diff).toContainText('@@ -1,1 +1,2 @@');
  await expect(diff.locator('.add')).toHaveText(['+b', '+c']);
  await details.getByRole('button', { name: /Result record/ }).click();
  await expect(details.getByText('Raw record from')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await page.getByRole('button', { name: 'Edits', exact: true }).click();
});

test('focuses a zone and explains inferred repair work', async () => {
  await zone('Repair Bay').click();
  const details = page.getByRole('complementary', { name: 'Details' });
  await expect(details).toContainText('Inferred.');
  await expect(page.getByRole('button', { name: /Zone: Repair Bay/ })).toBeVisible();
  await expect(timeline().getByRole('option')).toHaveCount(1); // only the failing test run
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Zone: Repair Bay/ })).toBeHidden();
});

test('streams new activity live over the WebSocket', async () => {
  const lines = demoSession().main.jsonl().split('\n').filter(Boolean);
  fs.appendFileSync(TRANSCRIPT, lines.slice(-LIVE_TAIL).join('\n') + '\n');
  await expect(timeline().getByText('Asked: Ship it now?')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fix date parser');
  await expect(zone('Approval Gate')).toContainText('1 APPROVED · 1 BLOCKED');
  await expect(zone('Review & Delivery')).toContainText('1 CHANGED');
});

test('replays the session from any point and returns to live', async () => {
  await page.getByRole('slider', { name: 'Replay position' }).fill('6');
  await expect(page.getByText(/Replaying: the session as it was/)).toBeVisible();
  await expect(zone('Implementation')).toContainText('0 FILES');
  await page.keyboard.press('l');
  await expect(page.getByText(/Replaying: the session/)).toBeHidden();
  await expect(zone('Implementation')).toContainText('1 FILE');
});

test('keyboard navigation, search and dialogs', async () => {
  await page.keyboard.press('/');
  await page.keyboard.type('clean build');
  await expect(timeline().getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Escape'); // leave the search box
  await page.keyboard.press('j');
  await expect(page.getByRole('complementary', { name: 'Details' }).getByRole('heading')).toHaveText('Clean build dir');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();

  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Coverage/ }).click();
  const coverage = page.getByRole('dialog', { name: /Coverage/ });
  await expect(coverage).toContainText('claude-code-log v3');
  await expect(coverage).toContainText('values redacted');
  await page.keyboard.press('Escape');
  await expect(coverage).toBeHidden();
});

// Regenerate the README screenshots from the synthetic session: BE_SCREENSHOTS=1 pnpm test:e2e
test('README screenshots', async () => {
  test.skip(!process.env.BE_SCREENSHOTS, 'set BE_SCREENSHOTS=1 to regenerate');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.keyboard.press('Escape');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // Earlier tests leave the page scrolled; every shot starts from the top, with the map settled.
  const top = async () => { await page.evaluate(() => document.querySelector('.main')?.scrollTo(0, 0)); await page.waitForTimeout(900); };
  await top();
  await page.screenshot({ path: 'docs/images/overview.png' });
  await page.getByRole('button', { name: 'Edits', exact: true }).click();
  await timeline().getByRole('option').first().click();
  await top();
  await page.screenshot({ path: 'docs/images/inspector.png' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await zone('Repair Bay').click();
  await top();
  await page.screenshot({ path: 'docs/images/dark-repair.png' });
});
