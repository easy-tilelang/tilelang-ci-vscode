import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_FILTERS, type DashboardState, type QueueJob, type QueueSnapshot } from '../src/shared/model.js';

function fixture(): DashboardState {
  const jobs: QueueJob[] = Array.from({ length: 12 }, (_, index) => ({
    id: index + 100, runId: index + 200, name: `CUDA test ${index + 1}`, workflow: 'CI', status: 'queued',
    createdAt: '2026-10-27T02:00:00Z', startedAt: null, rank: index + 1,
    url: `https://github.com/example/repo/actions/runs/${index + 200}/job/${index + 100}`,
    runUrl: `https://github.com/example/repo/actions/runs/${index + 200}`,
    labels: ['nvidia', 'self-hosted'], runnerName: null,
    pr: {
      number: [8, 11].includes(index) ? 42 : index + 1,
      title: [8, 11].includes(index) ? 'Improve kernel compilation' : `Other change ${index + 1}`,
      author: [8, 11].includes(index) ? 'alice' : 'bob', url: `https://github.com/example/repo/pull/${[8, 11].includes(index) ? 42 : index + 1}`,
      state: 'open', merged: false, staleHead: index === 11, association: 'reference',
    },
    own: [8, 11].includes(index),
  }));
  const snapshot: QueueSnapshot = {
    repository: 'example/repo', viewer: 'alice', fetchedAt: '2026-10-27T03:00:00Z', startedAt: '2026-10-27T02:59:30Z',
    queues: [
      { key: 'nvidia', labels: ['nvidia', 'self-hosted'], queued: jobs, running: [] },
      { key: 'h100', labels: ['h100', 'nvidia', 'self-hosted'], queued: [{ ...jobs[0]!, id: 999, labels: ['h100', 'nvidia', 'self-hosted'] }], running: [] },
    ],
    heldJobs: [], unrankedRuns: [{ id: 666, name: 'Approval workflow', status: 'waiting', url: 'https://github.com/example/repo/actions/runs/666', createdAt: '2026-10-27T02:00:00Z', pr: jobs[8]!.pr, own: true, reason: 'no-jobs' }],
    diagnostics: [], queuePartial: false, associationPartial: false,
  };
  return { repository: 'example/repo', account: 'alice', snapshot, loading: false, error: null, retryAt: null, filters: { ...DEFAULT_FILTERS }, autoRefresh: true, refreshIntervalSeconds: 120, locale: 'en', discoveryWarnings: [] };
}

async function mount(page: Page, state: DashboardState) {
  const [script, css] = await Promise.all([
    readFile(new URL('../dist/webview.js', import.meta.url), 'utf8'),
    readFile(new URL('../dist/webview.css', import.meta.url), 'utf8'),
  ]);
  await page.addInitScript(initial => {
    let current = initial;
    const testWindow = window as typeof window & { acquireVsCodeApi: () => { postMessage: (message: { type: string; filters?: DashboardState['filters'] }) => void }; messages: unknown[] };
    testWindow.messages = [];
    testWindow.acquireVsCodeApi = () => ({ postMessage(message) {
      testWindow.messages.push(message);
      if (message.type === 'setFilters' && message.filters) current = { ...current, filters: message.filters };
      if (message.type === 'ready' || message.type === 'setFilters') queueMicrotask(() => window.postMessage({ type: 'state', state: current }, '*'));
    } });
  }, state);
  await page.route('https://tilelang-ci.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ contentType: path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html', body: path.endsWith('.js') ? script : path.endsWith('.css') ? css : '<!doctype html><html><head><link rel="stylesheet" href="/webview.css"></head><body><div id="root"></div><script src="/webview.js"></script></body></html>' });
  });
  await page.goto('https://tilelang-ci.test/');
  await expect(page.getByRole('heading', { name: state.locale === 'en' ? 'CI resource queues' : 'CI 资源队列', exact: true })).toBeVisible();
}

test('filtering keeps resource positions, and PR details expose every job', async ({ page }) => {
  await mount(page, fixture());
  await page.getByRole('checkbox', { name: 'Only mine' }).check();
  const rows = page.locator('table tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('td').first()).toHaveText('9');
  await expect(rows.nth(1).locator('td').first()).toHaveText('12');
  await expect(page.getByText('First at #9', { exact: true })).toBeVisible();
  await page.locator('.job-details summary').click();
  await expect(page.locator('.job-details').getByRole('link', { name: 'CUDA test 12', exact: true })).toBeVisible();
  await page.getByRole('searchbox').fill('CUDA test 12');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('td').first()).toHaveText('12');
  await expect(page.locator('.unranked-list')).toHaveCount(0);
});

test('resource groups remain separate and workflows without jobs stay visible', async ({ page }) => {
  await mount(page, fixture());
  await expect(page.locator('.resource-table')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'No resource position yet' })).toBeVisible();
  await expect(page.getByText('Workflow status: waiting · No displayable jobs created yet')).toBeVisible();
  await page.locator('.resource-card').filter({ has: page.locator('.resource-card-title', { hasText: 'h100' }) }).click();
  await expect(page.locator('.resource-table')).toHaveCount(1);
  await expect(page.locator('.resource-table h3')).toHaveText('h100 · nvidia');
  await expect(page.locator('table tbody tr td').first()).toHaveText('1');
});

test('partial and stale results are explicit and external navigation uses the host', async ({ page }) => {
  const state = fixture();
  state.snapshot!.queuePartial = true;
  state.snapshot!.associationPartial = true;
  state.error = 'Network unavailable';
  state.retryAt = Date.now() + 60_000;
  await mount(page, state);
  await expect(page.getByText('Queue collection is incomplete.', { exact: false })).toBeVisible();
  await expect(page.getByText('Some PR associations are unconfirmed.', { exact: false })).toBeVisible();
  await expect(page.getByText('Last successful update', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh queues', exact: true })).toBeDisabled();
  await page.locator('.my-card').getByRole('link', { name: '#42', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { messages: { type: string; url?: string }[] }).messages.filter(message => message.type === 'openExternal'))).toEqual([{ type: 'openExternal', url: 'https://github.com/example/repo/pull/42' }]);
});

test('wide and narrow layouts fit the viewport, while the loading icon uses a constant rotation', async ({ page }) => {
  const state = fixture();
  state.loading = true;
  await page.setViewportSize({ width: 2560, height: 1200 });
  await mount(page, state);
  let metrics = await page.locator('.dashboard').evaluate(element => ({ width: element.getBoundingClientRect().width, viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(metrics.width).toBe(metrics.viewport);
  expect(metrics.scroll).toBe(metrics.viewport);
  await expect(page.locator('.refresh-button .refresh-icon')).toHaveCSS('animation-timing-function', 'linear');
  await page.setViewportSize({ width: 390, height: 844 });
  metrics = await page.locator('.dashboard').evaluate(element => ({ width: element.getBoundingClientRect().width, viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(metrics.scroll).toBe(metrics.viewport);
  await expect(page.getByRole('button', { name: 'Refreshing', exact: true })).toBeVisible();
});

test('onboarding offers repository selection, login and the offline demo', async ({ page }) => {
  const state = fixture();
  state.snapshot = null;
  state.account = null;
  state.repository = null;
  state.locale = 'zh-cn';
  await mount(page, state);
  await expect(page.getByRole('heading', { name: '在编辑器中查看 GitHub CI 等待顺序' })).toBeVisible();
  await page.getByRole('button', { name: '查看演示', exact: false }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { messages: { type: string }[] }).messages.some(message => message.type === 'demo'))).toBe(true);
  await expect(page.getByRole('button', { name: '选择仓库', exact: true })).toHaveCount(2);
});
