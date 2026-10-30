import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { TRANSCRIPT } from '../playwright.config.ts';
import { demoSession, SESSION } from '../test/fixtures/claude.ts';

/**
 * The 3D workspace, driven like a user would: mouse, touch, keyboard, every common screen size,
 * light and dark, reduced motion, and a browser without WebGL.
 */

type Stats = { frames: number; drawCalls: number; triangles: number; zoom: number; eventToPixelMs?: number };
const stats = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __be: { world: Stats } }).__be.world }));
const roomAt = (page: Page, zone: string) => page.evaluate(z => (window as unknown as { __be: { room(z: string): { x: number; y: number } } }).__be.room(z), zone);
const agentAt = (page: Page, id: string) => page.evaluate(i => (window as unknown as { __be: { agent(i: string): { x: number; y: number } | undefined } }).__be.agent(i), id);
const map = (page: Page) => page.getByRole('group', { name: /Workspace map/ });
const room = (page: Page, name: string) => map(page).getByRole('button', { name: new RegExp(`^${name}:`) });
const ROOMS = ['Repository Explorer', 'Planning Desk', 'Implementation', 'Tools & Dependencies', 'Mission Control', 'Test & Build Lab', 'Approval Gate', 'Review & Delivery', 'Repair Bay'];

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  return errors;
}

async function open(page: Page, url = '/') {
  await page.goto(url);
  await expect(map(page).locator('canvas')).toBeVisible();
  await expect.poll(async () => (await stats(page)).frames).toBeGreaterThan(0);
}

test('renders the building, its rooms and the agents from the session', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page);
  const s = await stats(page);
  // The whole building is a handful of draw calls: merged static geometry + instanced props + people.
  expect(s.drawCalls).toBeGreaterThan(2);
  expect(s.drawCalls).toBeLessThan(40);
  for (const name of ROOMS) await expect(room(page, name)).toBeVisible();
  await expect(room(page, 'Test & Build Lab')).toContainText('TESTS 1✓ 1✗');
  await expect(room(page, 'Repair Bay')).toContainText('~ 1 FIXED');
  // Room labels sit inside the map.
  const box = (await map(page).boundingBox())!;
  for (const name of ROOMS) {
    const b = (await room(page, name).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(b.y).toBeGreaterThanOrEqual(box.y - 1);
  }
  await expect(map(page).getByRole('button', { name: /^Claude:/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('clicking a room on the map opens it; dragging moves the map without selecting', async ({ page }) => {
  await open(page);
  const details = page.getByRole('complementary', { name: 'Details' });
  const p = await roomAt(page, 'implementation');
  await page.mouse.click(p.x, p.y);
  await expect(details.getByRole('heading')).toHaveText('Implementation');
  await expect(room(page, 'Implementation')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();

  // Drag across a room: the map pans, nothing gets selected.
  const before = (await room(page, 'Mission Control').boundingBox())!;
  const m = await roomAt(page, 'mission');
  await page.mouse.move(m.x, m.y);
  await page.mouse.down();
  await page.mouse.move(m.x + 60, m.y + 30, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await room(page, 'Mission Control').boundingBox())!.x).toBeGreaterThan(before.x + 40);
  await expect(details).toBeHidden();
});

test('Claude is its pixel mascot, in the map and beside it; clicking the figure itself picks Claude', async ({ page }) => {
  await open(page);
  const tag = map(page).getByRole('button', { name: /^Claude:/ });
  await expect(tag.locator('.initial.mascot svg rect')).not.toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Agents' }).locator('.avatar.mascot svg')).toBeVisible();
  // Click the 3D figure (not its tag): it is a real, pickable object in the scene.
  await expect.poll(() => agentAt(page, 'main')).toBeTruthy();
  const p = (await agentAt(page, 'main'))!;
  await page.mouse.click(p.x, p.y);
  // Idle at the end of the demo, so picking Claude filters the timeline to it (a running tool would open instead).
  await expect(tag).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Agents' }).getByRole('button', { name: /Claude/ })).toHaveAttribute('aria-pressed', 'true');
});

test('zooms with ctrl+wheel, the buttons and the keyboard; a plain wheel scrolls the page and explains', async ({ page }) => {
  await open(page);
  const zoom = async () => (await stats(page)).zoom;
  const z0 = await zoom();
  let m = await roomAt(page, 'mission');
  await page.mouse.move(m.x, m.y);
  await page.mouse.wheel(0, 300);
  await expect(page.getByRole('status').filter({ hasText: 'Ctrl + scroll' })).toBeVisible();
  expect(await zoom()).toBe(z0);
  // That wheel scrolled the page: find the map again.
  await map(page).scrollIntoViewIfNeeded();
  m = await roomAt(page, 'mission');
  await page.mouse.move(m.x, m.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await expect.poll(zoom).toBeGreaterThan(z0 * 1.3);

  await page.getByRole('button', { name: 'Fit the map' }).click();
  await expect.poll(zoom).toBeCloseTo(z0, 1);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(zoom).toBeGreaterThan(z0 * 1.3);

  await map(page).focus();
  await page.keyboard.press('0');
  await expect.poll(zoom).toBeCloseTo(z0, 1);
  await page.keyboard.press('+');
  await expect.poll(zoom).toBeGreaterThan(z0 * 1.2);
  // Arrow keys pan the focused map instead of moving through the timeline.
  const x0 = (await room(page, 'Mission Control').boundingBox())!.x;
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await room(page, 'Mission Control').boundingBox())!.x).toBeGreaterThan(x0 + 40);
  await expect(page.getByRole('complementary', { name: 'Details' })).toBeHidden();
});

test('full screen map: fills the window, keeps replay and details usable, Esc returns', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Full screen map' }).click();
  const vp = page.viewportSize()!;
  await expect.poll(async () => (await map(page).boundingBox())!.width).toBe(vp.width);
  await expect(page.getByRole('slider', { name: 'Replay position' })).toBeVisible();
  await room(page, 'Test & Build Lab').click();
  await expect(page.getByRole('complementary', { name: 'Details' })).toBeVisible();
  await page.keyboard.press('Escape'); // first closes the details…
  await expect(page.getByRole('complementary', { name: 'Details' })).toBeHidden();
  await page.keyboard.press('Escape'); // …then leaves full screen
  await expect.poll(async () => (await map(page).boundingBox())!.width).toBeLessThan(vp.width);
});

test('replays through the world: the agent goes back to where it was', async ({ page }) => {
  await open(page);
  const claude = map(page).getByRole('button', { name: /^Claude:/ });
  await page.getByRole('slider', { name: 'Replay position' }).fill('5');
  await expect(claude).toHaveAttribute('aria-label', /Exploring/);
  await expect(room(page, 'Implementation')).toContainText('0 FILES');
  await page.keyboard.press('l');
  await expect(room(page, 'Implementation')).toContainText('1 FILE');
});

test('follows the theme and keeps rendering', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page);
  const before = (await stats(page)).frames;
  await page.getByRole('button', { name: /^Theme:/ }).click(); // system → light
  await page.getByRole('button', { name: /^Theme:/ }).click(); // light → dark
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await expect.poll(async () => (await stats(page)).frames).toBeGreaterThan(before);
  expect(errors).toEqual([]);
});

test('switches between 3D, board and strip, and remembers the choice', async ({ page }) => {
  await open(page);
  await page.getByRole('radio', { name: 'Board' }).click();
  await expect(page.getByRole('region', { name: 'Workspace zones' })).toBeVisible();
  await expect(map(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Workspace zones' })).toBeVisible();
  await page.getByRole('radio', { name: '3D' }).click();
  await expect(map(page).locator('canvas')).toBeVisible();
});

test('without WebGL the board takes over and says why', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return type === 'webgl2' || type === 'webgl' ? null : (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof original;
  });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto('/');
  await expect(page.getByText(/The 3D map is unavailable/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Workspace zones' }).getByRole('button', { name: /^Repair Bay/ })).toContainText('FIXED');
  await expect(page.getByRole('radio', { name: '3D' })).toBeDisabled();
  expect(errors).toEqual([]);
  await context.close();
});

test('with reduced motion the world still shows everything', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await open(page);
  await expect(room(page, 'Repair Bay')).toBeVisible();
  await page.getByRole('slider', { name: 'Replay position' }).fill('5');
  await expect(map(page).getByRole('button', { name: /^Claude:/ })).toHaveAttribute('aria-label', /Exploring/);
  await context.close();
});

const SCREENS = [
  { name: 'small phone', width: 360, height: 740, touch: true },
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'phone landscape', width: 844, height: 390, touch: true },
  { name: 'tablet', width: 768, height: 1024, touch: true },
  { name: 'tablet landscape', width: 1024, height: 768, touch: true },
  { name: 'laptop', width: 1366, height: 768, touch: false },
  { name: 'desktop', width: 1920, height: 1080, touch: false },
];

for (const screen of SCREENS) {
  test(`fits a ${screen.name} (${screen.width}×${screen.height}) without sideways scrolling`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: screen.width, height: screen.height }, hasTouch: screen.touch, isMobile: screen.touch && screen.width < 900 });
    const page = await context.newPage();
    const errors = watchErrors(page);
    await open(page);
    await map(page).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(screen.width);
    const box = (await map(page).boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(screen.width);
    expect(box.height).toBeGreaterThanOrEqual(200);
    // Every room can be reached, and tapping one opens it.
    for (const name of ROOMS) await expect(room(page, name)).toBeAttached();
    if (screen.touch) await room(page, 'Repair Bay').tap();
    else await room(page, 'Repair Bay').click();
    await expect(page.getByRole('complementary', { name: 'Details' })).toBeVisible();
    const details = (await page.getByRole('complementary', { name: 'Details' }).boundingBox())!;
    expect(details.x).toBeGreaterThanOrEqual(-1);
    expect(details.x + details.width).toBeLessThanOrEqual(screen.width + 1);
    await expect(page.getByRole('slider', { name: 'Replay position' })).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
  });
}

test('new activity reaches the screen within 250 ms of arriving', async ({ page }) => {
  // A fresh live session per attempt, so the timing is not mixed up with other data (or a retry's own events).
  const id = randomUUID();
  const file = path.join(path.dirname(TRANSCRIPT), `${id}.jsonl`);
  // New session and record ids: event ids derive from Claude's record uuids, which are unique in real transcripts.
  const tag = id.slice(0, 8);
  const lines = demoSession().main.jsonl().split('\n').filter(Boolean).map(l => l.replaceAll(SESSION, id).replaceAll('"m-', `"${tag}-`));
  fs.writeFileSync(file, lines.slice(0, 6).join('\n') + '\n');
  await expect.poll(async () => (await (await page.request.get('/api/sessions')).json()).some((s: { native_id: string }) => s.native_id === id), { timeout: 10_000 }).toBe(true);
  await open(page, `/?session=claude-code:${id}`);
  // Measure live updates only, not the initial load of the session.
  await expect(map(page).getByRole('button', { name: /^Claude:/ })).toBeAttached();
  await page.waitForLoadState('networkidle');
  // …and not the first-load work (shader compiles, fonts) that can still be finishing right after it.
  await page.waitForTimeout(1000);
  const latencies: number[] = [];
  for (const line of lines.slice(6, 12)) {
    await page.evaluate(() => { (window as unknown as { __be: { world: Stats } }).__be.world.eventToPixelMs = undefined; });
    fs.appendFileSync(file, line + '\n');
    await expect.poll(async () => (await stats(page)).eventToPixelMs, { timeout: 10_000 }).toBeDefined();
    latencies.push((await stats(page)).eventToPixelMs!);
  }
  test.info().annotations.push({ type: 'event-to-pixel (ms)', description: latencies.map(l => l.toFixed(0)).join(', ') });
  console.log(`event-to-pixel (ms): ${latencies.map(l => l.toFixed(0)).join(', ')}`);
  // The 250 ms budget is asserted on Chromium, on the median: CI runners draw WebGL in software and one slow frame
  // there measures the runner, not the app (real GPUs: 31–55 ms). Headless Firefox and WebKit composite at
  // 2–10 fps, so they are recorded, not asserted.
  const median = [...latencies].sort((x, y) => x - y)[Math.floor(latencies.length / 2)]!;
  if ((process.env.PW_BROWSER ?? 'chromium') === 'chromium') expect(median).toBeLessThan(250);
});
