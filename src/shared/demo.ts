import { buildSnapshot } from '../core/snapshot.js';
import type { ApiJob, ApiPull, ApiRun } from '../core/types.js';
import type { QueueSnapshot } from './model.js';

/** Synthetic data only: importing this module never contacts GitHub. */
export function createDemoSnapshot(viewer = 'demo-user'): QueueSnapshot {
  const repository = 'tile-ai/tilelang';
  const now = Date.now();
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const pulls: ApiPull[] = [
    { number: 101, title: '[CUDA] Improve shared-memory layout inference', user: { login: 'alice' }, state: 'open', base: { repo: { full_name: repository } }, head: { sha: 'a'.repeat(40) } },
    { number: 102, title: '[Ascend] Add vector kernel regression coverage', user: { login: viewer }, state: 'open', base: { repo: { full_name: repository } }, head: { sha: 'b'.repeat(40) } },
    { number: 103, title: '[Docs] Publish updated installation guide', user: { login: viewer }, state: 'closed', merged_at: ago(90), base: { repo: { full_name: repository } }, head: { sha: 'c'.repeat(40) } },
    { number: 104, title: '[CI] Validate a contributor workflow', user: { login: viewer }, state: 'open', base: { repo: { full_name: repository } }, head: { sha: 'd'.repeat(40) } },
  ];
  const runs: ApiRun[] = pulls.map((pull, index) => ({
    id: 1000 + index, name: index === 2 ? 'Publish docs' : 'CI', status: index === 3 ? 'waiting' : 'in_progress',
    event: 'pull_request', head_sha: pull.head?.sha, created_at: ago(90 - index * 10), run_attempt: 1,
    pull_requests: [{ number: pull.number, url: `https://api.github.com/repos/${repository}/pulls/${pull.number}` }],
  }));
  const jobs: ApiJob[] = [
    { id: 1, run_id: 1000, name: 'CUDA / Python 3.12', status: 'queued', labels: ['self-hosted', 'nvidia'], created_at: ago(65) },
    { id: 2, run_id: 1001, name: 'CUDA / Python 3.12', status: 'queued', labels: ['self-hosted', 'nvidia'], created_at: ago(42) },
    { id: 3, run_id: 1002, name: 'Build and publish documentation', status: 'queued', labels: ['self-hosted', 'nvidia'], created_at: ago(26) },
    { id: 4, run_id: 1001, name: 'Ascend unit tests', status: 'queued', labels: ['self-hosted', 'ascend'], created_at: ago(38) },
    { id: 5, run_id: 1001, name: 'Ascend examples', status: 'queued', labels: ['self-hosted', 'ascend'], created_at: ago(31) },
    { id: 6, run_id: 1000, name: 'CUDA build', status: 'in_progress', labels: ['self-hosted', 'nvidia'], created_at: ago(80), started_at: ago(69), runner_name: 'gpu-runner-01' },
    { id: 7, run_id: 1001, name: 'macOS packaging', status: 'in_progress', labels: ['macos-latest'], created_at: ago(12), started_at: ago(8), runner_name: 'GitHub Actions 1' },
  ];
  const snapshot = buildSnapshot({ repository, viewer, runs, jobs, pulls, now: new Date(now) });
  snapshot.demo = true;
  return snapshot;
}
