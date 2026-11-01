import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_ROOT, TRANSCRIPT } from '../playwright.config.ts';
import { demoSession } from '../test/fixtures/claude.ts';
import { COPILOT_SESSION, copilotLive } from '../test/fixtures/copilot.ts';

/**
 * Regenerates the product site's screenshots from the real app running the synthetic sessions, in both themes:
 * BE_SITE_SHOTS=1 pnpm test:e2e e2e/site-shots.e2e.ts
 */

const OUT = 'site/public/shots';
const WAITING_ID = '0c0p1107-0000-4000-8000-00000000wait';

test.describe.configure({ mode: 'serial' });
// Twice the pixels: the page shows each shot cropped to its feature, and it must stay sharp on high-density screens.
test.use({ deviceScaleFactor: 2 });
test.skip(!process.env.BE_SITE_SHOTS, 'set BE_SITE_SHOTS=1 to regenerate the site screenshots');

/** Opens a session with the clock just after its activity, so times read as they would live ("2m", not "3d"). */
async function open(page: Page, theme: 'light' | 'dark', title: RegExp, at: string) {
  await page.clock.setFixedTime(new Date(at));
  await page.addInitScript(t => { try { localStorage.setItem('be.theme', t); localStorage.setItem('be.sidebar', 'open'); } catch { /* ignore */ } }, theme);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sessions' }).getByRole('button', { name: title }).click();
  await expect(page.getByRole('group', { name: /Workspace map/ })).toBeVisible();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(2200);
}

/** The part of the 1440×900 app each feature is about (CSS pixels); the page's <img> sizes mirror these. */
const CLIP = {
  workspace: { x: 272, y: 52, width: 1168, height: 760 },
  inspector: { x: 292, y: 52, width: 1148, height: 800 },
  replay: { x: 272, y: 52, width: 1168, height: 848 },
  waiting: { x: 0, y: 52, width: 1010, height: 640 },
} as const;

const shot = (page: Page, name: keyof typeof CLIP, theme: string) =>
  page.screenshot({ path: path.join(OUT, `${name}-${theme}.jpg`), type: 'jpeg', quality: 80, clip: CLIP[name] });

test.beforeAll(() => {
  // The demo transcript is seeded with its last lines held back for the live test: show the finished session.
  fs.writeFileSync(TRANSCRIPT, demoSession().main.jsonl());
  // A Copilot session waiting for an approval, kept apart from the one the Copilot test answers.
  const file = path.join(E2E_ROOT, 'copilot', 'session-state', WAITING_ID, 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, copilotLive().seed.split(COPILOT_SESSION).join(WAITING_ID).replace('Add tags to notes', 'Ship the tagging feature'));
  fs.mkdirSync(OUT, { recursive: true });
});

for (const theme of ['light', 'dark'] as const) {
  test(`site screenshots (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    await open(page, theme, /Fix date parser|demo/, '2026-10-29T10:02:00Z');
    await shot(page, 'workspace', theme);

    await page.getByRole('button', { name: 'Edits', exact: true }).click();
    await page.getByRole('listbox').getByRole('option').first().click();
    await page.waitForTimeout(600);
    await shot(page, 'inspector', theme);
    await page.keyboard.press('Escape');

    const slider = page.getByRole('slider', { name: 'Replay position' });
    const max = Number(await slider.getAttribute('max'));
    await slider.fill(String(Math.round(max * 0.55)));
    await page.waitForTimeout(1600);
    await shot(page, 'replay', theme);

    await expect.poll(async () => (await (await page.request.get('/api/sessions')).json()).some((s: { id: string }) => s.id === `copilot-cli:${WAITING_ID}`), { timeout: 15_000 }).toBe(true);
    await open(page, theme, /Ship the tagging feature/, '2026-10-29T09:01:45Z');
    await shot(page, 'waiting', theme);

    await page.getByRole('button', { name: 'Coverage' }).click();
    await page.waitForTimeout(500);
    const dialog = page.getByRole('dialog');
    console.log('coverage size', JSON.stringify(await dialog.boundingBox()));
    await dialog.screenshot({ path: path.join(OUT, `coverage-${theme}.jpg`), type: 'jpeg', quality: 80 });
  });
}
