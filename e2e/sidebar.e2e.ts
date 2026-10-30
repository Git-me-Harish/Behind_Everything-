import { expect, test, type Page } from '@playwright/test';

/** The sessions list: a column that collapses (and stays collapsed) on wide screens, a drawer on narrow ones. */

const sessions = (page: Page) => page.getByRole('navigation', { name: 'Sessions' });
const mainWidth = async (page: Page) => (await page.getByRole('main').boundingBox())!.width;

test('collapses and reopens on wide screens, by button or the s key, and remembers it', async ({ page }) => {
  await page.goto('/');
  await expect(sessions(page)).toBeVisible();
  const before = await mainWidth(page);

  await page.getByRole('button', { name: 'Hide sessions' }).click();
  await expect(sessions(page)).toBeHidden();
  await expect.poll(() => mainWidth(page)).toBeGreaterThan(before + 200);
  // The 3D map follows the new width.
  await expect.poll(async () => (await page.getByRole('group', { name: /Workspace map/ }).boundingBox())!.width).toBeGreaterThan(before);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Show sessions' })).toHaveAttribute('aria-expanded', 'false');
  await expect(sessions(page)).toBeHidden();

  await page.locator('body').press('s');
  await expect(sessions(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide sessions' })).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => mainWidth(page)).toBeLessThan(before + 1);
  await page.reload();
  await expect(sessions(page)).toBeVisible();
});

test('is a drawer on phones: opens over the page, closes on a tap outside, Esc or picking a session', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(sessions(page)).toBeHidden();
  const width = await mainWidth(page);

  const toggle = page.getByRole('button', { name: 'Show sessions' });
  await toggle.tap();
  await expect(sessions(page)).toBeVisible();
  expect(await mainWidth(page)).toBe(width); // over the page, not beside it
  await page.locator('.drawer-scrim').tap({ position: { x: 370, y: 300 } });
  await expect(sessions(page)).toBeHidden();

  await toggle.tap();
  await expect(sessions(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sessions(page)).toBeHidden();

  await toggle.tap();
  await sessions(page).getByRole('button').first().tap();
  await expect(sessions(page)).toBeHidden();
  await context.close();
});
