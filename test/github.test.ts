import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { Collector, GitHubClient, GitHubError } from '../src/core/index.js';
import type { ApiPull, ApiRun } from '../src/core/types.js';

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const repo = 'example/project';
const sha = 'a'.repeat(40);
const run: ApiRun = { id: 100, status: 'queued', event: 'pull_request', head_sha: sha, head_repository: { full_name: 'alice/project' }, run_attempt: 1, pull_requests: [{ number: 7, url: `https://api.github.com/repos/${repo}/pulls/7` }] };
const pull: ApiPull = { number: 7, title: 'Test PR', user: { login: 'alice' }, state: 'open', base: { repo: { full_name: repo } }, head: { sha, ref: 'feature', repo: { full_name: 'alice/project' } } };
function fixtureFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => handler(new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url), init);
}

test('transport only performs GET and scopes authorization to api.github.com', async () => {
  let requests = 0;
  const client = new GitHubClient('secret', { fetch: fixtureFetch((url, init) => {
    requests++;
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.pathname, '/user');
    assert.equal(init?.method, 'GET');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret');
    return json({ login: 'alice' });
  }) });
  assert.deepEqual(await client.get('user'), { login: 'alice' });
  for (const url of ['https://example.com/user', '//evil.test/user', 'http://api.github.com/user', 'https://x:secret@api.github.com/user', 'https://api.github.com:444/user']) await assert.rejects(client.get(url), /api.github.com/);
  assert.equal(requests, 1);
});
test('anonymous public GET omits authorization', async () => {
  const client = new GitHubClient('', { fetch: fixtureFetch((_url, init) => {
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return json({});
  }) });
  await client.get('/repos/example/project');
});
test('ETag conditional response reuses cached data and clear removes it', async () => {
  let requests = 0;
  const client = new GitHubClient('token', { fetch: fixtureFetch((_url, init) => {
    const etag = new Headers(init?.headers).get('if-none-match');
    requests++;
    if (requests === 2) { assert.equal(etag, '"v1"'); return new Response(null, { status: 304 }); }
    assert.equal(etag, null);
    return json({ value: requests }, 200, { etag: '"v1"' });
  }) });
  assert.deepEqual(await client.get('/user'), { value: 1 });
  assert.deepEqual(await client.get('/user'), { value: 1 });
  client.clear();
  assert.deepEqual(await client.get('/user'), { value: 3 });
});
test('pagination follows Link rather than guessing from item count', async () => {
  const client = new GitHubClient('', { fetch: fixtureFetch(url => url.searchParams.get('page') === '2'
    ? json({ jobs: [2], total_count: 2 })
    : json({ jobs: [1], total_count: 2 }, 200, { link: '<https://api.github.com/repos/example/project/actions/runs/100/jobs?page=2>; rel="next"' })) });
  assert.deepEqual(await client.pages<number>('/repos/example/project/actions/runs/100/jobs', 'jobs'), { items: [1, 2], total: 2, truncated: false });
});
test('pagination preserves earlier pages when a later page fails', async () => {
  const client = new GitHubClient('', { fetch: fixtureFetch(url => url.searchParams.get('page') === '2'
    ? json({}, 503)
    : json({ jobs: [1], total_count: 2 }, 200, { link: '<https://api.github.com/jobs?page=2>; rel="next"' })) });
  const result = await client.pages<number>('/jobs', 'jobs');
  assert.deepEqual(result.items, [1]);
  assert.equal(result.truncated, true);
  assert.equal(result.error?.status, 503);
});
test('pagination rejects a malicious next-link host before sending credentials', async () => {
  let requests = 0;
  const client = new GitHubClient('secret', { fetch: fixtureFetch(() => {
    requests++;
    return json([], 200, { link: '<https://evil.test/token>; rel="next"' });
  }) });
  await assert.rejects(client.pages('/items'), /api.github.com/);
  assert.equal(requests, 1);
});
test('concurrent callers are serialized', async () => {
  let release!: () => void;
  let started = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = new GitHubClient('', { fetch: fixtureFetch(async () => {
    started++;
    if (started === 1) await gate;
    return json({});
  }) });
  const first = client.get('/first');
  const second = client.get('/second');
  await setImmediate();
  assert.equal(started, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(started, 2);
});
test('primary rate limit honors reset and blocks manual calls until retryAt', async () => {
  let now = 1_000_000;
  let count = 0;
  const client = new GitHubClient('', { now: () => now, fetch: fixtureFetch(() => {
    count++;
    return count === 1 ? json({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1060' }) : json({});
  }) });
  await assert.rejects(client.get('/user'), error => error instanceof GitHubError && error.retryAt === 1_060_000);
  await assert.rejects(client.get('/user'), error => error instanceof GitHubError && error.retryAt === 1_060_000);
  assert.equal(count, 1);
  now = 1_060_001;
  await client.get('/user');
  assert.equal(count, 2);
});
test('Retry-After and secondary rate limits are distinct from permissions', async () => {
  const client = new GitHubClient('', { now: () => 1_000_000, fetch: fixtureFetch(() => json({}, 429, { 'retry-after': '12' })) });
  await assert.rejects(client.get('/user'), error => error instanceof GitHubError && error.retryAt === 1_012_000);
  const secondary = new GitHubClient('', { now: () => 1_000_000, fetch: fixtureFetch(() => json({ message: 'You have exceeded a secondary rate limit.' }, 403)) });
  await assert.rejects(secondary.get('/user'), error => error instanceof GitHubError && error.retryAt === 1_060_000);
  const denied = new GitHubClient('', { fetch: fixtureFetch(() => json({ message: 'private-content' }, 403)) });
  await assert.rejects(denied.get('/user'), error => error instanceof GitHubError && error.retryAt === null && !error.message.includes('private-content'));
});
test('a successful last allowed response records the upcoming limit', async () => {
  const client = new GitHubClient('', { now: () => 1_000_000, fetch: fixtureFetch(() => json({}, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1060' })) });
  await client.get('/user');
  assert.equal(client.retryAt, 1_060_000);
});
test('network error text and server response text never leak into errors', async () => {
  const client = new GitHubClient('my-secret-token', { fetch: fixtureFetch(() => { throw new Error('my-secret-token https://private-host'); }) });
  await assert.rejects(client.get('/user'), error => error instanceof GitHubError && !error.message.includes('my-secret-token') && !error.message.includes('private-host'));
});
test('redirects cannot forward authorization to another origin', async () => {
  let count = 0;
  const client = new GitHubClient('secret', { fetch: fixtureFetch(() => { count++; return new Response(null, { status: 302, headers: { location: 'https://evil.test/private' } }); }) });
  await assert.rejects(client.get('/user'), /api.github.com/);
  assert.equal(count, 1);
});
test('abort and timeout stop the active request', async () => {
  const pending = fixtureFetch((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
  const client = new GitHubClient('', { fetch: pending });
  const controller = new AbortController();
  const request = client.get('/user', controller.signal);
  await setImmediate();
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  const timeout = new GitHubClient('', { fetch: pending, timeoutMs: 5 });
  await assert.rejects(timeout.get('/user'), /timed out/);
});
test('clear aborts both active and already queued requests', async () => {
  const client = new GitHubClient('', { fetch: fixtureFetch((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))) });
  const first = client.get('/one');
  const second = client.get('/two');
  const results = Promise.allSettled([first, second]);
  await setImmediate();
  client.clear();
  assert.equal((await results).every(result => result.status === 'rejected' && (result.reason as Error).name === 'AbortError'), true);
});

function routes(overrides: (url: URL) => Response | undefined = () => undefined): typeof fetch {
  return fixtureFetch(url => {
    const override = overrides(url);
    if (override) return override;
    if (url.pathname === `/repos/${repo}`) return json({ full_name: repo });
    if (url.pathname === `/repos/${repo}/actions/runs`) return json({ workflow_runs: url.searchParams.get('status') === 'queued' ? [run] : [], total_count: url.searchParams.get('status') === 'queued' ? 1 : 0 });
    if (url.pathname === `/repos/${repo}/actions/runs/100/jobs`) return json({ jobs: [{ id: 1, status: 'queued', labels: ['nvidia'], created_at: '2026-10-16T01:00:00Z', run_attempt: 1 }], total_count: 1 });
    if (url.pathname === `/repos/${repo}/pulls/7`) return json(pull);
    if (url.pathname === `/repos/${repo}/commits/${sha}/pulls`) return json([pull]);
    throw new Error('Unexpected route');
  });
}
test('collector reads current attempts and associates author without scanning every PR', async () => {
  const result = await new Collector(new GitHubClient('', { fetch: routes() })).collect(repo, 'alice');
  assert.equal(result.queues[0]!.queued[0]!.own, true);
  assert.equal(result.queuePartial, false);
  assert.equal(result.associationPartial, false);
});
test('collector includes running-workflow queued jobs and deduplicates status race', async () => {
  let jobRequests = 0;
  const fetcher = routes(url => {
    if (url.pathname.endsWith('/actions/runs') && url.searchParams.get('status') === 'in_progress') return json({ workflow_runs: [{ ...run, status: 'in_progress' }], total_count: 1 });
    if (url.pathname.endsWith('/100/jobs')) jobRequests++;
    return undefined;
  });
  const result = await new Collector(new GitHubClient('', { fetch: fetcher })).collect(repo, 'alice');
  assert.equal(jobRequests, 1);
  assert.equal(result.queues[0]!.queued.length, 1);
});
test('collector keeps no-job workflow and marks a failed job request separately', async () => {
  const fetcher = routes(url => {
    if (url.pathname.endsWith('/actions/runs') && url.searchParams.get('status') === 'waiting') return json({ workflow_runs: [{ ...run, id: 101, status: 'waiting' }, { ...run, id: 102, status: 'pending' }], total_count: 2 });
    if (url.pathname.endsWith('/101/jobs')) return json({ jobs: [], total_count: 0 });
    if (url.pathname.endsWith('/102/jobs')) return json({}, 503);
    return undefined;
  });
  const result = await new Collector(new GitHubClient('', { fetch: fetcher })).collect(repo, 'alice');
  assert.equal(result.unrankedRuns.find(r => r.id === 101)?.reason, 'no-jobs');
  assert.equal(result.unrankedRuns.find(r => r.id === 102)?.reason, 'jobs-unavailable');
  assert.equal(result.unrankedRuns.every(r => r.own), true);
  assert.equal(result.queuePartial, true);
});
test('PR failures affect identity completeness without changing queue completeness', async () => {
  const fetcher = routes(url => /\/pulls\/7$|\/commits\//.test(url.pathname) ? json({}, 503) : undefined);
  const result = await new Collector(new GitHubClient('', { fetch: fetcher })).collect(repo, 'alice');
  assert.equal(result.queuePartial, false);
  assert.equal(result.associationPartial, true);
  assert.equal(result.queues[0]!.queued[0]!.pr, null);
});
test('a failed workflow state is explicitly partial', async () => {
  const fetcher = routes(url => url.pathname.endsWith('/actions/runs') && url.searchParams.get('status') === 'pending' ? json({}, 503) : undefined);
  const result = await new Collector(new GitHubClient('', { fetch: fetcher })).collect(repo, '');
  assert.equal(result.queuePartial, true);
});
test('repository access failure and complete Actions failure never become an empty queue', async () => {
  await assert.rejects(new Collector(new GitHubClient('', { fetch: fixtureFetch(() => json({}, 404)) })).collect(repo, ''), error => error instanceof GitHubError && error.status === 404);
  await assert.rejects(new Collector(new GitHubClient('', { fetch: routes(url => url.pathname.endsWith('/actions/runs') ? json({}, 403) : undefined) })).collect(repo, ''), error => error instanceof GitHubError && error.status === 403);
});
test('filtered run search truncation is a visible queue warning', async () => {
  const fetcher = routes(url => url.pathname.endsWith('/actions/runs') && url.searchParams.get('status') === 'queued' ? json({ workflow_runs: [run], total_count: 1001 }) : undefined);
  const result = await new Collector(new GitHubClient('', { fetch: fetcher })).collect(repo, '');
  assert.equal(result.queuePartial, true);
  assert.equal(result.diagnostics.some(d => d.message.includes('1,000')), true);
});
test('run without an event PR reference can use a unique exact head association', async () => {
  const fetcher = routes(url => url.pathname.endsWith('/actions/runs') && url.searchParams.get('status') === 'queued' ? json({ workflow_runs: [{ ...run, pull_requests: [] }], total_count: 1 }) : undefined);
  const result = await new Collector(new GitHubClient('', { fetch: fetcher })).collect(repo, 'alice');
  assert.equal(result.queues[0]!.queued[0]!.pr?.association, 'head');
});
test('complete commit association retains older head PR jobs with current PR details', async () => {
  const current = { ...pull, head: { ...pull.head, sha: 'b'.repeat(40) } };
  const fetcher = routes(url => {
    if (url.pathname.endsWith('/actions/runs') && url.searchParams.get('status') === 'queued') return json({ workflow_runs: [{ ...run, pull_requests: [] }], total_count: 1 });
    if (url.pathname.includes('/commits/')) return json([current]);
    return undefined;
  });
  const result = await new Collector(new GitHubClient('', { fetch: fetcher })).collect(repo, 'alice');
  assert.equal(result.queues[0]!.queued[0]!.pr?.association, 'commit');
  assert.equal(result.queues[0]!.queued[0]!.pr?.staleHead, true);
  assert.equal(result.queues[0]!.queued[0]!.own, true);
});
test('incomplete commit pages cannot establish a falsely unique old-head association', async () => {
  const fetcher = routes(url => {
    if (url.pathname.endsWith('/actions/runs') && url.searchParams.get('status') === 'queued') return json({ workflow_runs: [{ ...run, pull_requests: [] }], total_count: 1 });
    if (url.pathname.includes('/commits/')) return url.searchParams.get('page') === '2' ? json({}, 503) : json([{ ...pull, head: { sha: 'b'.repeat(40) } }], 200, { link: `</repos/${repo}/commits/${sha}/pulls?page=2>; rel="next"` });
    return undefined;
  });
  const result = await new Collector(new GitHubClient('', { fetch: fetcher })).collect(repo, 'alice');
  assert.equal(result.queues[0]!.queued[0]!.pr, null);
  assert.equal(result.associationPartial, true);
});
test('rate limiting is propagated for the host scheduler rather than swallowed as partial data', async () => {
  const fetcher = routes(url => url.pathname.endsWith('/100/jobs') ? json({}, 429, { 'retry-after': '60' }) : undefined);
  await assert.rejects(new Collector(new GitHubClient('', { fetch: fetcher })).collect(repo, 'alice'), error => error instanceof GitHubError && error.retryAt !== null);
});
