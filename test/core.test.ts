import test from 'node:test';
import assert from 'node:assert/strict';
import { associatePull, buildSnapshot, deduplicateRuns, normalizeLabels, parseRepository, parseTimestamp, validatedReferenceNumber } from '../src/core/index.js';
import type { ApiJob, ApiPull, ApiRun } from '../src/core/types.js';
import { createDemoSnapshot } from '../src/shared/demo.js';

const repo = 'example/project';
const sha = 'a'.repeat(40);
function pull(changes: Partial<ApiPull> = {}): ApiPull {
  return { number: 7, title: 'Improve compiler', user: { login: 'alice' }, state: 'open', base: { repo: { full_name: repo } }, head: { sha, ref: 'feature', repo: { full_name: 'alice/project' } }, ...changes };
}
function run(changes: Partial<ApiRun> = {}): ApiRun {
  return { id: 100, name: 'CI', status: 'queued', event: 'pull_request', head_sha: sha, head_branch: 'feature', head_repository: { full_name: 'alice/project' }, created_at: '2026-10-16T01:00:00Z', run_attempt: 1, pull_requests: [], ...changes };
}
function job(changes: Partial<ApiJob> = {}): ApiJob {
  return { id: 1000, run_id: 100, name: 'CUDA test', status: 'queued', labels: ['self-hosted', 'nvidia'], created_at: '2026-10-16T01:01:00Z', ...changes };
}
function snapshot(jobs: ApiJob[], runs = [run()], pulls = [pull()]) {
  return buildSnapshot({ repository: repo, viewer: 'ALICE', jobs, runs, pulls, now: new Date('2026-10-16T03:00:00Z') });
}

test('repository parser accepts canonical owner/repo and GitHub links', () => {
  for (const value of ['example/project', ' https://github.com/example/project.git/ ', 'github.com/example/project']) assert.equal(parseRepository(value), repo);
});
test('repository parser rejects credentials, other hosts, traversal and URL suffixes', () => {
  for (const value of ['http://github.com/example/project', 'https://github.com.evil/example/project', 'https://github.com@evil/example/project', 'https://user:secret@github.com/example/project', 'https://github.com/example/a/../project', 'https://github.com/example/project?x=1', 'https://github.com/example/project#x', 'example/..', 'example/project/actions']) assert.throws(() => parseRepository(value), Error, value);
});
test('resource grouping normalizes order, case, whitespace and duplicates', () => {
  assert.deepEqual(normalizeLabels([' Self-Hosted ', 'NVIDIA', 'nvidia', '', 4]), ['nvidia', 'self-hosted']);
  assert.equal(snapshot([job(), job({ id: 1001, labels: ['NVIDIA', 'Self-Hosted'] })]).queues.length, 1);
});
test('specialized labels are separate logical queues', () => {
  assert.equal(snapshot([job(), job({ id: 1001, labels: ['nvidia', 'self-hosted', 'h100'] })]).queues.length, 2);
});
test('jobs sort by creation time then ID; running jobs have no queue rank', () => {
  const result = snapshot([job({ id: 3 }), job({ id: 2 }), job({ id: 1, created_at: '2026-10-16T00:59:00Z' }), job({ id: 4, status: 'in_progress' })]);
  assert.deepEqual(result.queues[0]!.queued.map(j => [j.id, j.rank]), [[1, 1], [2, 2], [3, 3]]);
  assert.equal(result.queues[0]!.running[0]!.rank, null);
  assert.equal(result.queues[0]!.queued.every(j => j.own), true);
});
test('one PR may occupy multiple independent job positions', () => {
  const result = snapshot([job(), job({ id: 1001 })]);
  assert.deepEqual(result.queues[0]!.queued.map(j => j.pr?.number), [7, 7]);
  assert.deepEqual(result.queues[0]!.queued.map(j => j.rank), [1, 2]);
});
test('PR author is used and not the workflow trigger identity', () => {
  const result = buildSnapshot({ repository: repo, viewer: 'maintainer', runs: [run()], jobs: [job()], pulls: [pull()] });
  assert.equal(result.queues[0]!.queued[0]!.pr?.author, 'alice');
  assert.equal(result.queues[0]!.queued[0]!.own, false);
});
test('weak branch-only match is never confirmed as a PR', () => {
  assert.equal(associatePull(repo, run({ head_sha: 'b'.repeat(40) }), [pull()]), null);
  assert.equal(associatePull(repo, run({ event: 'pull_request_target', head_sha: 'b'.repeat(40) }), [pull()]), null);
});
test('validated event reference can associate an old PR commit', () => {
  const result = associatePull(repo, run({ head_sha: 'b'.repeat(40), pull_requests: [{ number: 7, url: `https://api.github.com/repos/${repo}/pulls/7` }] }), [pull()]);
  assert.equal(result?.association, 'reference');
  assert.equal(result?.staleHead, true);
});
test('complete commit endpoint evidence can confirm an old head without a branch-only guess', () => {
  const current = pull({ head: { sha: 'b'.repeat(40), ref: 'feature', repo: { full_name: 'alice/project' } } });
  const associated = associatePull(repo, run(), [current], [current]);
  assert.equal(associated?.association, 'commit');
  assert.equal(associated?.staleHead, true);
  assert.equal(associated?.author, 'alice');
});
test('commit association rejects ambiguous and foreign results', () => {
  const current = pull({ head: { sha: 'b'.repeat(40) } });
  assert.equal(associatePull(repo, run(), [current], [current, pull({ number: 8, head: { sha: 'c'.repeat(40) } })]), null);
  assert.equal(associatePull(repo, run(), [], [pull({ base: { repo: { full_name: 'other/project' } } })]), null);
});
test('commit evidence never attributes schedule, dispatch, or non-merge push jobs to a PR', () => {
  for (const event of ['schedule', 'issue_comment', 'repository_dispatch', 'workflow_dispatch', 'push']) {
    assert.equal(associatePull(repo, run({ event, head_sha: 'b'.repeat(40) }), [pull()], [pull()]), null);
  }
});
test('foreign same-number references and contradictory reference numbers are rejected', () => {
  assert.equal(validatedReferenceNumber({ number: 7, url: 'https://api.github.com/repos/other/project/pulls/7' }, repo), null);
  assert.equal(validatedReferenceNumber({ number: 8, url: `https://api.github.com/repos/${repo}/pulls/7` }, repo), null);
  assert.equal(validatedReferenceNumber({ number: 7, base: { repo: { full_name: repo } } }, repo), 7);
  assert.equal(associatePull(repo, run({ head_sha: 'z', pull_requests: [{ number: 7, url: 'https://api.github.com/repos/other/project/pulls/7' }] }), [pull()]), null);
});
test('multiple PR references and equal head matches remain ambiguous', () => {
  const second = pull({ number: 8 });
  assert.equal(associatePull(repo, run(), [pull(), second]), null);
  assert.equal(associatePull(repo, run({ pull_requests: [7, 8].map(number => ({ number, url: `https://api.github.com/repos/${repo}/pulls/${number}` })) }), [pull()]), null);
});
test('same branch in another fork is not sufficient', () => {
  assert.equal(associatePull(repo, run({ head_repository: { full_name: 'bob/project' } }), [pull()]), null);
});

test('identical commits on other branches do not establish a head association', () => {
  assert.equal(associatePull(repo, run({ head_branch: 'other-feature' }), [pull()]), null);
  const other = pull({ number: 8, head: { ...pull().head, ref: 'other-feature' } });
  assert.equal(associatePull(repo, run(), [pull(), other])?.number, 7);
});
test('merged push is associated only through its merge commit', () => {
  const merged = pull({ state: 'closed', merged_at: '2026-10-16T00:00:00Z', merge_commit_sha: 'b'.repeat(40) });
  const associated = associatePull(repo, run({ event: 'push', head_sha: 'b'.repeat(40) }), [merged]);
  assert.equal(associated?.merged, true);
  assert.equal(associated?.association, 'merge');
  assert.equal(associatePull(repo, run({ event: 'push' }), [pull()]), null);
});
test('schedule/comment events do not borrow a PR through a shared main SHA', () => {
  for (const event of ['schedule', 'issue_comment', 'repository_dispatch']) assert.equal(associatePull(repo, run({ event }), [pull()]), null);
});
test('closed and merged PR jobs remain visible', () => {
  const result = snapshot([job()], [run()], [pull({ state: 'closed', merged_at: '2026-10-16T00:00:00Z' })]);
  assert.equal(result.queues[0]!.queued[0]!.pr?.merged, true);
});
test('missing labels and invalid time are displayed without a fabricated queue rank', () => {
  const result = snapshot([job({ labels: [] }), job({ id: 1001, created_at: 'not-a-time' })]);
  assert.equal(result.queues.length, 0);
  assert.equal(result.heldJobs.length, 2);
  assert.equal(result.heldJobs.every(j => j.rank === null), true);
  assert.equal(result.queuePartial, true);
});
test('timestamps require an explicit timezone', () => {
  assert.equal(parseTimestamp('2026-10-16T01:00:00'), null);
  assert.equal(parseTimestamp('2026-10-16'), null);
  assert.equal(parseTimestamp('2026-10-16T09:00:00+08:00'), Date.parse('2026-10-16T01:00:00Z'));
});
test('completed and old attempt jobs are excluded before de-duplication', () => {
  const result = snapshot([job({ status: 'completed' }), job({ run_attempt: 1 }), job({ run_attempt: 2 })], [run({ run_attempt: 2 })]);
  assert.equal(result.queues[0]!.queued.length, 1);
});
test('duplicate workflow records prefer a newer attempt or updated record', () => {
  assert.equal(deduplicateRuns([run(), run({ run_attempt: 2 })])[0]!.run_attempt, 2);
  assert.equal(deduplicateRuns([run(), run({ status: 'completed' })]).length, 0);
});
test('active workflows without jobs remain visible and personally marked', () => {
  const result = snapshot([], [run({ status: 'waiting' })]);
  assert.equal(result.unrankedRuns[0]!.reason, 'no-jobs');
  assert.equal(result.unrankedRuns[0]!.own, true);
  assert.equal(result.queuePartial, false);
});
test('jobs unavailable is distinct from a workflow with no active jobs', () => {
  const result = buildSnapshot({ repository: repo, viewer: '', runs: [run()], jobs: [], pulls: [], unavailableRunIds: new Set([100]), diagnostics: [{ kind: 'queue', message: 'Unavailable jobs' }] });
  assert.equal(result.unrankedRuns[0]!.reason, 'jobs-unavailable');
  assert.equal(result.queuePartial, true);
  assert.equal(result.associationPartial, true);
});
test('unknown association does not make the collected resource queue partial', () => {
  const result = snapshot([job()], [run()], []);
  assert.equal(result.queuePartial, false);
  assert.equal(result.associationPartial, true);
  assert.equal(result.queues[0]!.queued[0]!.own, false);
});
test('unsupported external URLs cannot enter snapshots', () => {
  const result = snapshot([job({ html_url: 'javascript:alert(1)' })], [run({ html_url: 'https://example.com/private' })]);
  assert.equal(result.queues[0]!.queued[0]!.url, `https://github.com/${repo}/actions/runs/100/job/1000`);
});
test('demo is explicitly synthetic and exercises queued, running and unranked views', () => {
  const demo = createDemoSnapshot('me');
  assert.equal(demo.demo, true);
  assert.equal(demo.viewer, 'me');
  assert.equal(demo.queues.length, 3);
  assert.equal(demo.unrankedRuns.length, 1);
  assert.equal(demo.queues.some(q => q.queued.some(j => j.own)), true);
});
