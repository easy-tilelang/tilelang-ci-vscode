import type { Diagnostic, PullRequest, QueueGroup, QueueJob, QueueSnapshot, UnrankedRun } from '../shared/model.js';
import type { ApiJob, ApiPull, ApiRef, ApiRepository, ApiRun } from './types.js';

export const ACTIVE_STATUSES = ['queued', 'in_progress', 'requested', 'waiting', 'pending'] as const;

export function parseRepository(input: string): string {
  let value = input.trim();
  if (/^https:\/\//i.test(value)) {
    const match = /^https:\/\/github\.com\/([^?#]+)$/i.exec(value);
    if (!match) throw new Error('Enter owner/repo or https://github.com/owner/repo.');
    value = match[1]!;
  } else if (/^github\.com\//i.test(value)) {
    value = value.slice('github.com/'.length);
  }
  value = value.replace(/\/+$/, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value) || ['.', '..'].includes(value.split('/')[1]!)) {
    throw new Error('Repository must be owner/repo on github.com.');
  }
  return value;
}

export function normalizeLabels(labels: readonly unknown[] | undefined): string[] {
  return [...new Set((labels ?? []).filter((label): label is string => typeof label === 'string')
    .map(label => label.trim().toLowerCase()).filter(Boolean))].sort();
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

export function repositoryName(value: ApiRepository | null | undefined): string {
  if (typeof value?.full_name === 'string') {
    try { return parseRepository(value.full_name).toLowerCase(); } catch { return ''; }
  }
  const match = /^https:\/\/api\.github\.com\/repos\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)$/.exec(value?.url ?? '');
  return match?.[1]?.toLowerCase() ?? '';
}

export function validatedReferenceNumber(ref: ApiRef, repository: string): number | null {
  const target = repository.toLowerCase();
  const base = repositoryName(ref.base?.repo);
  if (base && base !== target) return null;
  const api = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(ref.url ?? '');
  const html = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(ref.url ?? '');
  const match = api ?? html;
  if (ref.url && !match) return null;
  if (match) {
    const number = Number(match[2]);
    if (match[1]!.toLowerCase() !== target || (ref.number !== undefined && ref.number !== number)) return null;
    return validId(number) ? number : null;
  }
  return base === target && validId(ref.number) ? ref.number! : null;
}

export function validId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function githubUrl(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port ? url.toString() : fallback;
  } catch { return fallback; }
}

/** Branch names alone are deliberately insufficient evidence for personal highlighting. */
export function associatePull(repository: string, run: ApiRun, candidates: readonly ApiPull[], commitCandidates: readonly ApiPull[] = []): PullRequest | null {
  const target = repository.toLowerCase();
  const byNumber = new Map<number, ApiPull>();
  for (const candidate of candidates) {
    if (validId(candidate.number) && repositoryName(candidate.base?.repo) === target) byNumber.set(candidate.number, candidate);
  }
  const pulls = [...byNumber.values()];
  const numbers = new Set((run.pull_requests ?? []).map(ref => validatedReferenceNumber(ref, target)).filter((n): n is number => n !== null));
  let selected: ApiPull | undefined;
  let association: PullRequest['association'] = 'reference';
  if (numbers.size === 1) selected = byNumber.get([...numbers][0]!);
  if (numbers.size > 1) return null;
  if (!selected) {
    if (run.event === 'push') {
      const matches = pulls.filter(pr => (pr.merged || pr.merged_at) && !!run.head_sha && pr.merge_commit_sha === run.head_sha);
      if (matches.length === 1) { selected = matches[0]; association = 'merge'; }
    } else if (['pull_request', 'pull_request_target', 'workflow_dispatch'].includes(run.event ?? '')) {
      const headRepo = repositoryName(run.head_repository);
      const matches = pulls.filter(pr => !!run.head_sha && pr.head?.sha === run.head_sha
        && (!headRepo || repositoryName(pr.head?.repo) === headRepo)
        && (!run.head_branch || pr.head?.ref === run.head_branch));
      if (matches.length === 1) { selected = matches[0]; association = 'head'; }
      if (matches.length > 1) return null;
      if (!selected && ['pull_request', 'pull_request_target'].includes(run.event ?? '')) {
        // This evidence comes only from the endpoint for this run's head SHA.
        // A current PR may already have advanced beyond the commit under test.
        const commitPulls = [...new Map(commitCandidates
          .filter(pr => validId(pr.number) && repositoryName(pr.base?.repo) === target)
          .map(pr => [pr.number, pr])).values()];
        if (commitPulls.length === 1) { selected = commitPulls[0]; association = 'commit'; }
      }
    }
  }
  if (!selected) return null;
  return {
    number: selected.number,
    title: typeof selected.title === 'string' ? selected.title : '',
    author: typeof selected.user?.login === 'string' ? selected.user.login : '',
    url: `https://github.com/${repository}/pull/${selected.number}`,
    state: selected.state === 'closed' ? 'closed' : 'open',
    merged: !!(selected.merged || selected.merged_at),
    staleHead: run.event === 'pull_request' && !!selected.head?.sha && !!run.head_sha && selected.head.sha !== run.head_sha,
    association,
  };
}

export interface SnapshotInput {
  repository: string;
  viewer: string;
  runs: readonly ApiRun[];
  jobs: readonly ApiJob[];
  pulls: readonly ApiPull[];
  commitPulls?: ReadonlyMap<string, readonly ApiPull[]>;
  diagnostics?: readonly Diagnostic[];
  unavailableRunIds?: ReadonlySet<number>;
  startedAt?: string;
  now?: Date;
}

export function deduplicateRuns(runs: readonly ApiRun[]): ApiRun[] {
  const index = new Map<number, ApiRun>();
  for (const run of runs) {
    if (!validId(run.id)) continue;
    const previous = index.get(run.id);
    if (!previous || (run.run_attempt ?? 1) > (previous.run_attempt ?? 1) ||
      ((run.run_attempt ?? 1) === (previous.run_attempt ?? 1) && (parseTimestamp(run.updated_at) ?? 0) >= (parseTimestamp(previous.updated_at) ?? 0))) index.set(run.id, run);
  }
  return [...index.values()].filter(run => run.status !== 'completed');
}

export function buildSnapshot(input: SnapshotInput): QueueSnapshot {
  const repository = parseRepository(input.repository);
  const viewer = input.viewer;
  const now = (input.now ?? new Date()).toISOString();
  const diagnostics: Diagnostic[] = [...(input.diagnostics ?? [])];
  const runs = deduplicateRuns(input.runs);
  const runIndex = new Map(runs.map(run => [run.id, run]));
  const associations = new Map(runs.map(run => [run.id, associatePull(repository, run, input.pulls, input.commitPulls?.get(run.head_sha ?? '') ?? [])]));
  const groups = new Map<string, QueueGroup>();
  const heldJobs: QueueJob[] = [];
  const seen = new Set<number>();
  const activeRuns = new Set<number>();
  const isOwn = (pr: PullRequest | null) => !!viewer && !!pr?.author && pr.author.toLowerCase() === viewer.toLowerCase();
  for (const job of input.jobs) {
    if (job.status === 'completed') continue;
    if (!validId(job.id)) { diagnostics.push({ kind: 'queue', message: 'A job has no valid ID and could not be displayed.' }); continue; }
    const run = runIndex.get(job.run_id);
    if (!run) continue;
    if (job.run_attempt && run.run_attempt && job.run_attempt !== run.run_attempt) continue;
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    activeRuns.add(run.id);
    const labels = normalizeLabels(job.labels);
    const created = parseTimestamp(job.created_at);
    const pr = associations.get(run.id) ?? null;
    const runUrl = githubUrl(run.html_url, `https://github.com/${repository}/actions/runs/${run.id}`);
    const row: QueueJob = {
      id: job.id, runId: run.id, name: job.name ?? '', workflow: run.name ?? job.workflow_name ?? '',
      status: job.status ?? 'unknown', createdAt: created === null ? null : job.created_at!,
      startedAt: parseTimestamp(job.started_at) === null ? null : job.started_at!, rank: null,
      url: githubUrl(job.html_url, `${runUrl}/job/${job.id}`), runUrl, labels,
      runnerName: typeof job.runner_name === 'string' ? job.runner_name : null, pr, own: isOwn(pr),
    };
    if (!pr && run.event?.startsWith('pull_request')) row.note = 'PR association could not be confirmed.';
    else if (pr?.staleHead) row.note = 'This job belongs to an earlier PR commit.';
    if (!['queued', 'in_progress'].includes(row.status) || !labels.length || (row.status === 'queued' && created === null)) {
      if (row.status === 'queued') {
        row.note = !labels.length ? 'Runner labels are unavailable; no resource rank is assigned.' : 'Job creation time is unavailable; no rank is assigned.';
        diagnostics.push({ kind: 'queue', message: `Job ${job.id}: ${row.note}` });
      }
      heldJobs.push(row);
      continue;
    }
    const key = JSON.stringify(labels);
    let group = groups.get(key);
    if (!group) { group = { key, labels, queued: [], running: [] }; groups.set(key, group); }
    (row.status === 'queued' ? group.queued : group.running).push(row);
  }
  const unrankedRuns: UnrankedRun[] = runs.filter(run => !activeRuns.has(run.id)).map(run => {
    const pr = associations.get(run.id) ?? null;
    return {
      id: run.id, name: run.name ?? '', status: run.status ?? 'unknown',
      url: githubUrl(run.html_url, `https://github.com/${repository}/actions/runs/${run.id}`),
      createdAt: parseTimestamp(run.created_at) === null ? null : run.created_at!,
      pr, own: isOwn(pr), reason: input.unavailableRunIds?.has(run.id) ? 'jobs-unavailable' : 'no-jobs',
    };
  });
  for (const run of runs) {
    if (run.event?.startsWith('pull_request') && !associations.get(run.id)) diagnostics.push({ kind: 'association', message: `Workflow ${run.id}: its PR could not be uniquely confirmed; personal highlighting may be incomplete.` });
  }
  const queues = [...groups.values()];
  for (const group of queues) {
    group.queued.sort((a, b) => parseTimestamp(a.createdAt)! - parseTimestamp(b.createdAt)! || a.id - b.id);
    group.queued.forEach((job, index) => { job.rank = index + 1; });
    group.running.sort((a, b) => (parseTimestamp(a.startedAt) ?? 0) - (parseTimestamp(b.startedAt) ?? 0) || a.id - b.id);
  }
  queues.sort((a, b) => b.queued.length - a.queued.length || b.running.length - a.running.length || a.key.localeCompare(b.key));
  const uniqueDiagnostics = [...new Map(diagnostics.map(diagnostic => [`${diagnostic.kind}:${diagnostic.message}`, diagnostic])).values()];
  return {
    repository, viewer, startedAt: input.startedAt ?? now, fetchedAt: now,
    queues, heldJobs, unrankedRuns, diagnostics: uniqueDiagnostics,
    queuePartial: uniqueDiagnostics.some(d => d.kind === 'queue'),
    associationPartial: uniqueDiagnostics.some(d => d.kind === 'association'),
  };
}
