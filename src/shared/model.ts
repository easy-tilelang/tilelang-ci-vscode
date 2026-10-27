export type Locale = 'zh-cn' | 'en';
export interface PullRequest {
  number: number;
  title: string;
  author: string;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  staleHead: boolean;
  association: 'reference' | 'head' | 'merge' | 'commit';
}
export interface QueueJob {
  id: number;
  runId: number;
  name: string;
  workflow: string;
  status: string;
  createdAt: string | null;
  startedAt: string | null;
  rank: number | null;
  url: string;
  runUrl: string;
  labels: string[];
  runnerName: string | null;
  pr: PullRequest | null;
  own: boolean;
  note?: string;
}
export interface QueueGroup {
  key: string;
  labels: string[];
  queued: QueueJob[];
  running: QueueJob[];
}
export interface UnrankedRun {
  id: number;
  name: string;
  status: string;
  url: string;
  createdAt: string | null;
  pr: PullRequest | null;
  own: boolean;
  reason: 'no-jobs' | 'jobs-unavailable';
}
export interface Diagnostic {
  kind: 'queue' | 'association' | 'discovery';
  message: string;
}
export interface QueueSnapshot {
  repository: string;
  viewer: string;
  fetchedAt: string;
  startedAt: string;
  queues: QueueGroup[];
  heldJobs: QueueJob[];
  unrankedRuns: UnrankedRun[];
  diagnostics: Diagnostic[];
  queuePartial: boolean;
  associationPartial: boolean;
  demo?: boolean;
}
export interface Filters {
  resource: string | null;
  mine: boolean;
  search: string;
  tab: 'queued' | 'running';
  pr: number | null;
}
export const DEFAULT_FILTERS: Filters = { resource: null, mine: false, search: '', tab: 'queued', pr: null };
export interface DashboardState {
  repository: string | null;
  account: string | null;
  snapshot: QueueSnapshot | null;
  loading: boolean;
  error: string | null;
  retryAt: number | null;
  filters: Filters;
  autoRefresh: boolean;
  refreshIntervalSeconds: number;
  locale: Locale;
  discoveryWarnings: string[];
}
export type ViewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'selectRepository' }
  | { type: 'signIn' }
  | { type: 'switchAccount' }
  | { type: 'enablePrivate' }
  | { type: 'demo' }
  | { type: 'showLogs' }
  | { type: 'setFilters'; filters: Filters }
  | { type: 'openExternal'; url: string };
export type HostMessage = { type: 'state'; state: DashboardState };
export function allJobs(snapshot: QueueSnapshot): QueueJob[] {
  return [...snapshot.queues.flatMap(q => [...q.queued, ...q.running]), ...snapshot.heldJobs];
}
