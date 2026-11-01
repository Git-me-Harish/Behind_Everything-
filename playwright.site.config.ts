import { defineConfig } from '@playwright/test';

/** Browser tests for the product site, against its production build: pnpm site:build && pnpm test:site */
export default defineConfig({
  testDir: 'site/e2e',
  testMatch: '*.e2e.ts',
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  ...(process.env.PW_BROWSER && process.env.PW_BROWSER !== 'chromium' ? { timeout: 120_000 } : {}),
  use: {
    baseURL: 'http://127.0.0.1:4174/Behind_Everything-/',
    browserName: (process.env.PW_BROWSER as 'chromium' | 'firefox' | 'webkit' | undefined) ?? 'chromium',
    channel: process.env.PW_CHANNEL || undefined,
    launchOptions: process.env.PW_BROWSER === 'firefox' ? { firefoxUserPrefs: { 'webgl.force-enabled': true } }
      : process.env.PW_BROWSER === 'webkit' ? {} : { args: ['--enable-unsafe-swiftshader'] },
    headless: !process.env.PW_HEADED,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite preview --config site/vite.config.ts --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174/Behind_Everything-/',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
