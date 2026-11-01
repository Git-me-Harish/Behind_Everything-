import { expect, test, type Page } from '@playwright/test';

/** The product page as a visitor gets it: complete, working, readable in both themes and at every size. */

function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', r => errors.push(`failed: ${r.url()}`));
  return errors;
}

test('the page tells the whole story, with the live 3D world in the hero', async ({ page }) => {
  const errors = watch(page);
  await page.goto('./');
  await expect(page).toHaveTitle(/Behind Everything/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('See what your AI coding agent is actually doing.');
  await expect(page.locator('#get-started').getByText('npx behind-everything')).toBeVisible();
  // The real renderer replaces the poster once it is up (WebGL is available in the test browsers).
  await expect(page.locator('.window-body.live')).toBeVisible({ timeout: 30_000 });
  for (const name of ['Claude', 'Codex', 'Copilot']) await expect(page.locator('.hw-agent', { hasText: name })).toBeVisible();
  for (const id of ['how', 'features', 'assistants', 'privacy', 'faq']) await expect(page.locator(`#${id}`)).toBeAttached();
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(6);
  expect(errors).toEqual([]);
});

test('every section and image loads, and no text uses an em dash', async ({ page }) => {
  await page.goto('./');
  const height = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < height; y += 600) {
    await page.evaluate(v => window.scrollTo(0, v), y);
    await page.waitForTimeout(60);
  }
  await page.waitForLoadState('networkidle');
  const broken = await page.evaluate(() => [...document.images].filter(i => i.checkVisibility() && !(i.complete && i.naturalWidth > 0)).map(i => i.src));
  expect(broken).toEqual([]);
  expect(await page.evaluate(() => document.body.innerText.includes('—'))).toBe(false);
  // Every in-page link has a target.
  const missing = await page.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')]
    .map(a => a.getAttribute('href')!).filter(h => h.length > 1 && !document.querySelector(h)));
  expect(missing).toEqual([]);
});

test('the install command copies, the nav jumps to sections, and the FAQ opens', async ({ page, browserName, context }) => {
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('./');
  await page.locator('#get-started').getByRole('button', { name: 'Copy "npx behind-everything"' }).click();
  if (browserName === 'chromium') {
    await expect(page.locator('#get-started').getByText('Copied to clipboard')).toBeAttached();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npx behind-everything');
  }

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Privacy' }).click();
  await expect(page.getByRole('heading', { name: 'Your code never leaves your machine' })).toBeInViewport();

  const faq = page.locator('#faq details').first();
  await faq.locator('summary').click();
  await expect(faq).toHaveAttribute('open', '');
  await expect(faq.getByText('Apache-2.0')).toBeVisible();
});

test('the theme toggle switches the page and its screenshots', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('./');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'light');
  const toggle = page.getByRole('button', { name: /^Theme:/ });
  await toggle.click(); // system, then light
  await toggle.click(); // light, then dark
  await expect(html).toHaveAttribute('data-theme', 'dark');
  const shot = page.locator('#feature-workspace .shot');
  await expect(shot.locator('img.only-dark')).toBeVisible();
  await expect(shot.locator('img.only-light')).toBeHidden();
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
});

for (const vp of [{ width: 360, height: 740 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
  test(`fits ${vp.width}×${vp.height} without sideways scrolling`, async ({ browser }) => {
    const mobile = vp.width < 800;
    const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile });
    const page = await ctx.newPage();
    await page.goto('./');
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.width);
    if (vp.width < 900) {
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'FAQ' }).click();
      await expect(page.getByRole('heading', { name: 'Questions, answered' })).toBeInViewport();
      await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
    }
    await ctx.close();
  });
}

test('with reduced motion the hero holds still', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('./');
  await expect(page.locator('.window-body.live')).toBeVisible({ timeout: 30_000 });
  const first = await page.locator('.hw-agent', { hasText: 'Claude' }).textContent();
  await page.waitForTimeout(4200);
  expect(await page.locator('.hw-agent', { hasText: 'Claude' }).textContent()).toBe(first);
  await ctx.close();
});
