import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './test', testMatch: 'webview.spec.ts', fullyParallel: true,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }, reporter: 'list',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }] });
