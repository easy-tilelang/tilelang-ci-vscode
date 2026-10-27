import type { Diagnostic, QueueSnapshot } from '../shared/model.js';
import { GitHubClient, GitHubError, abortError, isFatal, type PageResult } from './github.js';
import { ACTIVE_STATUSES, associatePull, buildSnapshot, deduplicateRuns, parseRepository, repositoryName, validId, validatedReferenceNumber } from './snapshot.js';
import type { ApiJob, ApiPull, ApiRepository, ApiRun } from './types.js';

function warnPage<T>(result: PageResult<T>, message: string, kind: Diagnostic['kind'], diagnostics: Diagnostic[]): void {
  if (result.truncated || result.error) diagnostics.push({ kind, message });
}

/** Collects one repository. The host owns scheduling, identity and cancellation. */
export class Collector {
  constructor(private readonly client: GitHubClient) {}
  async collect(input: string, viewer: string, signal?: AbortSignal): Promise<QueueSnapshot> {
    let repository = parseRepository(input);
    const startedAt = new Date().toISOString();
    const metadata = await this.client.get<ApiRepository>(`/repos/${repository}`, signal);
    if (metadata.full_name) repository = parseRepository(metadata.full_name);
    const base = `/repos/${repository}`;
    const diagnostics: Diagnostic[] = [];
    let runs: ApiRun[] = [];
    let failedStatuses = 0;
    let firstError: unknown;
    for (const status of ACTIVE_STATUSES) {
      try {
        const page = await this.client.pages<ApiRun>(`${base}/actions/runs?status=${status}`, 'workflow_runs', 10, signal);
        runs.push(...page.items);
        warnPage(page, `${status} workflows are incomplete${page.total !== null && page.total > 1000 ? ': GitHub limits filtered searches to 1,000 runs' : ': pagination failed or states changed during collection'}.`, 'queue', diagnostics);
      } catch (error) {
        if (isFatal(error)) throw error;
        firstError ??= error;
        failedStatuses++;
        diagnostics.push({ kind: 'queue', message: `Could not read ${status} workflows.` });
      }
    }
    if (failedStatuses === ACTIVE_STATUSES.length) throw firstError instanceof GitHubError ? firstError : new GitHubError('Could not read Actions workflows.');
    runs = deduplicateRuns(runs);
    const jobs: ApiJob[] = [];
    const unavailableRunIds = new Set<number>();
    for (const run of runs) {
      try {
        const page = await this.client.pages<ApiJob>(`${base}/actions/runs/${run.id}/jobs?filter=latest`, 'jobs', undefined, signal);
        jobs.push(...page.items.filter(job => job && typeof job === 'object').map(job => ({ ...job, run_id: run.id })));
        warnPage(page, `Workflow ${run.id}: some job pages could not be read.`, 'queue', diagnostics);
        if (page.error || page.truncated) unavailableRunIds.add(run.id);
      } catch (error) {
        if (isFatal(error)) throw error;
        unavailableRunIds.add(run.id);
        diagnostics.push({ kind: 'queue', message: `Workflow ${run.id}: jobs are unavailable.` });
      }
    }
    const pulls: ApiPull[] = [];
    const commitPulls = new Map<string, ApiPull[]>();
    const details = new Set<number>();
    for (const run of runs) for (const ref of run.pull_requests ?? []) {
      const number = validatedReferenceNumber(ref, repository);
      if (number) details.add(number);
    }
    for (const number of details) {
      try {
        const pull = await this.client.get<ApiPull>(`${base}/pulls/${number}`, signal);
        if (!validId(pull.number) || pull.number !== number) throw new GitHubError('GitHub returned an invalid pull request.');
        pulls.push(pull);
      } catch (error) {
        if (isFatal(error)) throw error;
        diagnostics.push({ kind: 'association', message: `PR #${number}: details could not be read.` });
      }
    }
    const resolvedShas = new Set<string>();
    for (const run of runs) {
      if (!['pull_request', 'pull_request_target', 'push', 'workflow_dispatch'].includes(run.event ?? '') || associatePull(repository, run, pulls)) continue;
      const sha = run.head_sha;
      if (!sha || !/^[0-9a-f]{40,64}$/i.test(sha) || resolvedShas.has(sha)) continue;
      resolvedShas.add(sha);
      try {
        const page = await this.client.pages<ApiPull>(`${base}/commits/${sha}/pulls`, undefined, undefined, signal);
        if (!page.truncated && !page.error) {
          pulls.push(...page.items);
          commitPulls.set(sha, page.items);
        }
        warnPage(page, `Commit ${sha.slice(0, 7)}: PR association results are incomplete.`, 'association', diagnostics);
      } catch (error) {
        if (isFatal(error)) throw error;
        diagnostics.push({ kind: 'association', message: `Commit ${sha.slice(0, 7)}: associated PRs could not be read.` });
      }
    }
    // Fork PR runs may expose neither PR references nor base-commit associations.
    // Discover candidates by the actual fork owner and branch, then require the
    // complete base + fork + branch + SHA tuple before admitting a candidate.
    const headQueries = new Map<string, ApiRun[]>();
    for (const run of runs) {
      if (!['pull_request', 'pull_request_target', 'workflow_dispatch'].includes(run.event ?? '')
        || associatePull(repository, run, pulls, commitPulls.get(run.head_sha ?? '') ?? [])) continue;
      const fork = repositoryName(run.head_repository);
      if (!fork || typeof run.head_branch !== 'string' || !run.head_branch
        || !run.head_sha || !/^[0-9a-f]{40,64}$/i.test(run.head_sha)) continue;
      const head = `${fork.split('/')[0]}:${run.head_branch}`;
      const matchingRuns = headQueries.get(head) ?? [];
      matchingRuns.push(run);
      headQueries.set(head, matchingRuns);
    }
    for (const [head, matchingRuns] of headQueries) {
      try {
        const query = new URLSearchParams({ state: 'all', head });
        const page = await this.client.pages<ApiPull>(`${base}/pulls?${query}`, undefined, undefined, signal);
        if (!page.truncated && !page.error) {
          pulls.push(...page.items.filter(pull => repositoryName(pull.base?.repo) === repository.toLowerCase()
            && matchingRuns.some(run => repositoryName(pull.head?.repo) === repositoryName(run.head_repository)
              && pull.head?.ref === run.head_branch && pull.head?.sha === run.head_sha)));
        }
        warnPage(page, 'Fork branch PR candidates are incomplete; personal highlighting may be incomplete.', 'association', diagnostics);
      } catch (error) {
        if (isFatal(error)) throw error;
        diagnostics.push({ kind: 'association', message: 'Fork branch PR candidates could not be read.' });
      }
    }
    if (signal?.aborted) throw abortError();
    return buildSnapshot({ repository, viewer, runs, jobs, pulls, commitPulls, diagnostics, unavailableRunIds, startedAt });
  }
}
