/**
 * Renders the product site's generated images from the site itself: the hero poster (shown until the live 3D
 * world loads, and when WebGL is unavailable) in both themes, and the social card. Run after `pnpm site:build`:
 *   pnpm site:assets            (PW_CHANNEL=msedge to use an installed browser)
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { preview } from 'vite';

const OUT = path.resolve('site/public');
const server = await preview({ configFile: 'site/vite.config.ts', preview: { port: 4174, strictPort: true } });
const url = server.resolvedUrls!.local[0]!;
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, args: ['--enable-unsafe-swiftshader'] });

try {
  for (const theme of ['light', 'dark'] as const) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1.5 });
    await page.addInitScript(t => localStorage.setItem('be.theme', t), theme);
    await page.goto(`${url}?hero-beat=1`);
    const body = page.locator('.window-body');
    await body.scrollIntoViewIfNeeded();
    await page.locator('.window-body.live').waitFor({ timeout: 30_000 });
    // Let the agents settle at their stations and the labels follow.
    await page.waitForTimeout(3500);
    await body.screenshot({ path: path.join(OUT, 'shots', `hero-${theme}.jpg`), type: 'jpeg', quality: 84 });
    await page.close();
  }

  const poster = fs.readFileSync(path.join(OUT, 'shots', 'hero-light.jpg')).toString('base64');
  const card = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await card.setContent(`<!doctype html><html><head><style>
    body { margin: 0; width: 1200px; height: 630px; font-family: 'Inter', 'Segoe UI', system-ui, sans-serif; color: #0f1724;
      background: radial-gradient(60% 70% at 15% 10%, #dff3f6, transparent 70%), radial-gradient(50% 60% at 95% 0%, #ece6fb, transparent 70%), #f6f8fb; overflow: hidden; }
    .copy { position: absolute; left: 72px; top: 76px; width: 470px; }
    .brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 24px; }
    h1 { margin: 40px 0 0; font-size: 58px; line-height: 1.05; letter-spacing: -0.035em; }
    p { margin: 24px 0 0; font-size: 21px; line-height: 1.45; color: #46546a; }
    code { display: inline-block; margin-top: 30px; padding: 14px 20px; border-radius: 12px; background: #10151f; color: #e8eef7; font: 22px 'Cascadia Code', Consolas, monospace; }
    code b { color: #64c2cc; font-weight: 400; margin-right: 10px; }
    .shot { position: absolute; right: -170px; top: 90px; width: 740px; border-radius: 18px; border: 1px solid #d5dde8; box-shadow: 0 30px 60px -20px rgba(15, 30, 50, .35); overflow: hidden; background: #fff; }
    .shot img { display: block; width: 100%; }
  </style></head><body>
    <div class="copy">
      <div class="brand"><svg width="34" height="34" viewBox="0 0 32 32"><path d="M16 3 29 10.5v11L16 29 3 21.5v-11Z" fill="#1f7f8c"/><path d="M16 3 29 10.5 16 18 3 10.5Z" fill="#64c2cc"/><path d="M16 18v11L3 21.5v-11Z" fill="#17606a"/></svg>Behind Everything</div>
      <h1>See what your AI coding agent is actually doing.</h1>
      <p>A live 3D workspace for Claude Code, Codex and GitHub Copilot CLI. Local-first, nothing to configure.</p>
      <code><b>$</b>npx behind-everything</code>
    </div>
    <div class="shot"><img src="data:image/jpeg;base64,${poster}"></div>
  </body></html>`);
  await card.waitForTimeout(300);
  await card.screenshot({ path: path.join(OUT, 'og.png') });
  console.log('Wrote site/public/shots/hero-{light,dark}.jpg and site/public/og.png');
} finally {
  await browser.close();
  await new Promise<void>(r => server.httpServer.close(() => r()));
}
