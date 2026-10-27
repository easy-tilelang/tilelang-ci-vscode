import assert from 'node:assert/strict';
import test from 'node:test';
import { Collector, GitHubClient } from '../src/core/index.js';
import type { ApiPull, ApiRun } from '../src/core/types.js';

const repository = 'tile-ai/tilelang';
const fork = 'erhsh/tilelang';
const sha = 'f872d7f9d46130588017d7af2901993bf77472c0';
const branch = 'fix/dynamic-output-shape-expressions';
const run: ApiRun = {
  id: 40492676802, status: 'in_progress', event: 'pull_request', run_attempt: 1,
  head_sha: sha, head_branch: branch, head_repository: { full_name: fork }, pull_requests: [],
};
const pull: ApiPull = {
  number: 3636, title: '[BugFix][JIT] Evaluate dynamic output shape expressions',
  state: 'open', user: { login: 'erhsh' },
  base: { repo: { full_name: repository } },
  head: { sha, ref: branch, repo: { full_name: fork } },
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}
interface Fixture {
  runs?: ApiRun[];
  headResponse?: (url: URL) => Response;
}
function fixture(options: Fixture = {}): { fetcher: typeof fetch; urls: URL[] } {
  const urls: URL[] = [];
  const runs = options.runs ?? [run];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    urls.push(url);
    assert.equal(init?.method, 'GET');
    assert.equal(url.origin, 'https://api.github.com');
    if (url.pathname === `/repos/${repository}`) return json({ full_name: repository });
    if (url.pathname === `/repos/${repository}/actions/runs`) {
      const active = url.searchParams.get('status') === 'in_progress' ? runs : [];
      return json({ workflow_runs: active, total_count: active.length });
    }
    const jobs = new RegExp(`^/repos/${repository}/actions/runs/(\\d+)/jobs$`).exec(url.pathname);
    if (jobs) {
      const id = Number(jobs[1]);
      assert.equal(url.searchParams.get('filter'), 'latest');
      return json({ jobs: [
        { id: id * 10 + 1, name: 'CUDA', status: 'in_progress', labels: ['self-hosted', 'nvidia'], created_at: '2026-10-27T10:59:00Z', started_at: '2026-10-27T11:00:40Z', run_attempt: 1 },
        { id: id * 10 + 2, name: 'ROCm', status: 'in_progress', labels: ['self-hosted', 'amd-gfx942'], created_at: '2026-10-27T10:59:00Z', started_at: '2026-10-27T11:06:13Z', run_attempt: 1 },
        { id: id * 10 + 3, name: 'Metal', status: 'in_progress', labels: ['macos-latest'], created_at: '2026-10-27T10:59:00Z', started_at: '2026-10-27T11:00:40Z', run_attempt: 1 },
      ], total_count: 3 });
    }
    // GitHub currently returns no association for the upstream commit endpoint.
    if (url.pathname === `/repos/${repository}/commits/${sha}/pulls`) return json([]);
    if (url.pathname === `/repos/${repository}/pulls`) {
      assert.equal(url.searchParams.get('state'), 'all');
      return options.headResponse?.(url) ?? json([pull]);
    }
    throw new Error(`Unexpected fixture endpoint: ${url.pathname}`);
  };
  return { fetcher, urls };
}
function running(result: Awaited<ReturnType<Collector['collect']>>) { return result.queues.flatMap(queue => queue.running); }

test('PR #3636 is recognized from its exact upstream head query when run and commit references are empty', async () => {
  const data = fixture();
  const result = await new Collector(new GitHubClient('', { fetch: data.fetcher })).collect(repository, 'erhsh');
  assert.equal(running(result).length, 3);
  assert.ok(running(result).every(job => job.own && job.pr?.number === 3636 && job.pr.author === 'erhsh'));
  assert.ok(running(result).every(job => job.rank === null && job.pr?.association === 'head'));
  assert.equal(result.queuePartial, false);
  assert.equal(result.associationPartial, false);
  const headQueries = data.urls.filter(url => url.pathname === `/repos/${repository}/pulls`);
  assert.equal(headQueries.length, 1);
  assert.equal(headQueries[0]!.searchParams.get('head'), `erhsh:${branch}`);
});

for (const [name, candidate] of [
  ['another fork with the same branch and SHA', { ...pull, head: { ...pull.head, repo: { full_name: 'another/tilelang' } } }],
  ['a newer SHA on the same branch', { ...pull, head: { ...pull.head, sha: 'b'.repeat(40) } }],
  ['another branch with the same fork and SHA', { ...pull, head: { ...pull.head, ref: 'unrelated-branch' } }],
  ['a foreign base repository', { ...pull, base: { repo: { full_name: 'another/tilelang' } } }],
] as const) {
  test(`head discovery cannot claim ${name}`, async () => {
    const data = fixture({ headResponse: () => json([candidate]) });
    const result = await new Collector(new GitHubClient('', { fetch: data.fetcher })).collect(repository, 'erhsh');
    assert.ok(running(result).every(job => !job.own && job.pr === null));
    assert.equal(data.urls.filter(url => url.pathname === `/repos/${repository}/pulls`).length, 1);
    assert.equal(result.queuePartial, false);
    assert.equal(result.associationPartial, true);
  });
}

test('head query failure makes PR attribution incomplete without changing queue completeness', async () => {
  const data = fixture({ headResponse: () => json({}, 503) });
  const result = await new Collector(new GitHubClient('', { fetch: data.fetcher })).collect(repository, 'erhsh');
  assert.equal(running(result).length, 3);
  assert.equal(data.urls.filter(url => url.pathname === `/repos/${repository}/pulls`).length, 1);
  assert.ok(running(result).every(job => !job.own && job.pr === null));
  assert.equal(result.queuePartial, false);
  assert.equal(result.associationPartial, true);
});

test('multiple PRs with the exact head remain ambiguous instead of claiming the first result', async () => {
  const data = fixture({ headResponse: () => json([pull, { ...pull, number: 3637 }]) });
  const result = await new Collector(new GitHubClient('', { fetch: data.fetcher })).collect(repository, 'erhsh');
  assert.equal(data.urls.filter(url => url.pathname === `/repos/${repository}/pulls`).length, 1);
  assert.ok(running(result).every(job => !job.own && job.pr === null));
  assert.equal(result.queuePartial, false);
  assert.equal(result.associationPartial, true);
});

test('a failed later head-query page cannot establish a falsely unique PR association', async () => {
  const data = fixture({ headResponse: url => url.searchParams.get('page') === '2'
    ? json({}, 503)
    : json([pull], 200, { link: `<https://api.github.com/repos/${repository}/pulls?state=all&head=${encodeURIComponent(`erhsh:${branch}`)}&page=2>; rel="next"` }) });
  const result = await new Collector(new GitHubClient('', { fetch: data.fetcher })).collect(repository, 'erhsh');
  assert.ok(data.urls.some(url => url.pathname === `/repos/${repository}/pulls` && url.searchParams.get('page') === '2'));
  assert.ok(running(result).every(job => !job.own && job.pr === null));
  assert.equal(result.queuePartial, false);
  assert.equal(result.associationPartial, true);
});

test('head query safely round-trips non-ASCII and URL-sensitive branch names', async () => {
  const special = 'fix/中文+queue#1&base=next';
  const data = fixture({ runs: [{ ...run, head_branch: special }], headResponse: url => {
    assert.equal(url.searchParams.get('head'), `erhsh:${special}`);
    assert.equal(url.searchParams.has('base'), false);
    return json([{ ...pull, head: { ...pull.head, ref: special } }]);
  } });
  const result = await new Collector(new GitHubClient('', { fetch: data.fetcher })).collect(repository, 'erhsh');
  assert.ok(running(result).every(job => job.own && job.pr?.number === 3636));
  assert.equal(result.associationPartial, false);
});

test('multiple workflows for one head reuse the head query', async () => {
  const data = fixture({ runs: [run, { ...run, id: run.id + 1 }] });
  const result = await new Collector(new GitHubClient('', { fetch: data.fetcher })).collect(repository, 'erhsh');
  assert.equal(running(result).length, 6);
  assert.ok(running(result).every(job => job.own));
  assert.equal(data.urls.filter(url => url.pathname === `/repos/${repository}/pulls`).length, 1);
});

for (const event of ['schedule', 'push']) {
  test(`${event} workflows do not borrow a PR through a matching branch query`, async () => {
    const data = fixture({ runs: [{ ...run, event }] });
    const result = await new Collector(new GitHubClient('', { fetch: data.fetcher })).collect(repository, 'erhsh');
    assert.ok(running(result).every(job => !job.own && job.pr === null));
    assert.equal(data.urls.filter(url => url.pathname === `/repos/${repository}/pulls`).length, 0);
  });
}
