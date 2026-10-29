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
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Locally, an installed Edge/Chrome avoids downloading a browser: PW_CHANNEL=msedge pnpm test:e2e
    channel: process.env.PW_CHANNEL || undefined,
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
