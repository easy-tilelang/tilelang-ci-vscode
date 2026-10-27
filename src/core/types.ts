/** The small subset of GitHub REST responses needed by the queue collector. */
export interface ApiRepository { full_name?: string; url?: string }
export interface ApiRef {
  number?: number;
  url?: string;
  base?: { repo?: ApiRepository };
}
export interface ApiRun {
  id: number;
  name?: string;
  status?: string;
  event?: string;
  head_sha?: string;
  head_branch?: string;
  head_repository?: ApiRepository;
  pull_requests?: ApiRef[];
  run_attempt?: number;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
}
export interface ApiJob {
  id: number;
  run_id: number;
  name?: string;
  workflow_name?: string;
  status?: string;
  labels?: unknown[];
  created_at?: string;
  started_at?: string;
  run_attempt?: number;
  html_url?: string;
  runner_name?: string | null;
}
export interface ApiPull {
  number: number;
  title?: string;
  user?: { login?: string };
  html_url?: string;
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  base?: { repo?: ApiRepository };
  head?: { sha?: string; ref?: string; repo?: ApiRepository | null };
}
