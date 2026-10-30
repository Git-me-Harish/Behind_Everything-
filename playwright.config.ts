import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { demoSession, SESSION } from './test/fixtures/claude.ts';

const PORT = 47950;
export const E2E_ROOT = path.join(os.tmpdir(), 'behind-everything-e2e');
export const TRANSCRIPT = path.join(E2E_ROOT, 'claude', 'projects', 'C--work-demo', `${SESSION}.jsonl`);
/** Lines withheld at startup; the live test appends them while the page is open. */
export const LIVE_TAIL = 8;

// The config is evaluated by the runner and again by each worker: seed the fake Claude home only once.
if (!process.env.BE_E2E_SEEDED) {
  process.env.BE_E2E_SEEDED = '1';
  fs.rmSync(E2E_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
  const lines = demoSession().main.jsonl().split('\n').filter(Boolean);
  fs.writeFileSync(TRANSCRIPT, lines.slice(0, -LIVE_TAIL).join('\n') + '\n');
}

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // Headless Firefox and WebKit draw WebGL in software and are several times slower than Chromium.
  ...(process.env.PW_BROWSER && process.env.PW_BROWSER !== 'chromium' ? { timeout: 240_000, expect: { timeout: 20_000 } } : {}),
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // One engine per run (the live test appends to the shared transcript): PW_BROWSER=firefox|webkit.
    browserName: (process.env.PW_BROWSER as 'chromium' | 'firefox' | 'webkit' | undefined) ?? 'chromium',
    // Locally, an installed Edge/Chrome avoids downloading a browser: PW_CHANNEL=msedge pnpm test:e2e
    channel: process.env.PW_CHANNEL || undefined,
    // The tests are about the 3D map, so make sure GPU-less machines still get WebGL: headless Chromium needs
    // SwiftShader allowed explicitly, and headless Firefox on Linux blocklists its software WebGL.
    launchOptions: process.env.PW_BROWSER === 'firefox' ? { firefoxUserPrefs: { 'webgl.force-enabled': true } }
      : process.env.PW_BROWSER === 'webkit' ? {} : { args: ['--enable-unsafe-swiftshader'] },
    // CI runs Firefox headed on a virtual display (xvfb) — the only way it gets WebGL on a GPU-less Linux runner.
    headless: !process.env.PW_HEADED,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node --import tsx src/cli.ts --port ${PORT} --no-open --quiet`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { CLAUDE_CONFIG_DIR: path.join(E2E_ROOT, 'claude'), BE_HOME: path.join(E2E_ROOT, 'data'), NO_COLOR: '1' },
  },
});
