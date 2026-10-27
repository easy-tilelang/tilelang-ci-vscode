export class GitHubError extends Error {
  readonly status: number | undefined;
  readonly retryAt: number | null;
  constructor(message: string, status?: number, retryAt: number | null = null) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.retryAt = retryAt;
  }
}

export function abortError(): Error {
  const error = new Error('Collection cancelled.');
  error.name = 'AbortError';
  return error;
}

export function isFatal(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError' || error instanceof GitHubError && (error.status === 401 || error.retryAt !== null);
}

interface CachedResponse { data: unknown; etag: string | null; next: string | null }
export interface PageResult<T> { items: T[]; total: number | null; truncated: boolean; error?: GitHubError }
export interface GitHubClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** Only authenticated, read-only requests to the fixed GitHub REST origin. */
export class GitHubClient {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CachedResponse>();
  private tail: Promise<void> = Promise.resolve();
  private lifetime = new AbortController();
  private blockedUntil = 0;
  constructor(private readonly token: string, options: GitHubClientOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }
  get retryAt(): number | null { return this.blockedUntil > this.now() ? this.blockedUntil : null; }
  clear(): void {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.cache.clear();
    this.blockedUntil = 0;
  }
  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return (await this.request(path, signal)).data as T;
  }
  async pages<T>(path: string, field?: string, maxPages = Number.POSITIVE_INFINITY, signal?: AbortSignal): Promise<PageResult<T>> {
    const initial = this.apiUrl(path);
    if (!initial.searchParams.has('per_page')) initial.searchParams.set('per_page', '100');
    let next: string | null = initial.toString();
    let total: number | null = null;
    const items: T[] = [];
    const visited = new Set<string>();
    let page = 0;
    while (next) {
      if (signal?.aborted) throw abortError();
      if (visited.has(next)) throw new GitHubError('GitHub returned a circular pagination link.');
      visited.add(next);
      let response: CachedResponse;
      try { response = await this.request(next, signal); }
      catch (error) {
        if (isFatal(error) || page === 0) throw error;
        return { items, total, truncated: true, error: error instanceof GitHubError ? error : new GitHubError('A GitHub page could not be read.') };
      }
      const data = response.data;
      const chunk = field && data && typeof data === 'object' ? (data as Record<string, unknown>)[field] : data;
      if (!Array.isArray(chunk)) throw new GitHubError('GitHub returned an invalid paginated response.');
      if (data && typeof data === 'object' && typeof (data as Record<string, unknown>).total_count === 'number') total = (data as { total_count: number }).total_count;
      items.push(...chunk as T[]);
      next = response.next;
      page++;
      if (page >= maxPages && next) return { items, total, truncated: true };
    }
    return { items, total, truncated: total !== null && total > items.length };
  }
  private apiUrl(path: string): URL {
    let url: URL;
    try { url = new URL(path.replace(/^repos\//, '/repos/').replace(/^user$/, '/user'), 'https://api.github.com/'); }
    catch { throw new GitHubError('Invalid GitHub API path.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.port || url.username || url.password || url.hash) throw new GitHubError('Only api.github.com requests are allowed.');
    return url;
  }
  private request(path: string, signal?: AbortSignal): Promise<CachedResponse> {
    const url = this.apiUrl(path).toString();
    const lifetime = this.lifetime.signal;
    const task = this.tail.then(() => this.performRequest(url, signal, lifetime));
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }
  private async performRequest(url: string, signal: AbortSignal | undefined, lifetime: AbortSignal): Promise<CachedResponse> {
    if (signal?.aborted || lifetime.aborted) throw abortError();
    if (this.retryAt !== null) throw new GitHubError('GitHub API rate limit reached. Retry after the displayed time.', 429, this.retryAt);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    lifetime.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      const cached = this.cache.get(url);
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'easy-tilelang-ci-vscode/0.1.1',
      };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      let current = url;
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 3; redirects++) {
        response = await this.fetcher(current, { method: 'GET', headers, signal: controller.signal, redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new GitHubError('GitHub returned an invalid redirect.');
        current = this.apiUrl(new URL(location, current).toString()).toString();
      }
      if (!response) throw new GitHubError('GitHub did not return a response.');
      const resetSeconds = Number(response.headers.get('x-ratelimit-reset'));
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (remaining === '0') this.blockedUntil = Math.max(this.now() + 1_000, Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 : this.now() + 60_000);
      if (response.status === 304) {
        if (!cached) throw new GitHubError('GitHub returned an uncached conditional response.');
        return cached;
      }
      if (!response.ok) {
        let secondary = false;
        if (response.status === 403) {
          try { secondary = /secondary rate limit|abuse detection/i.test((await response.json() as { message?: string }).message ?? ''); } catch { /* No raw server or network text is exposed. */ }
        }
        const retry = response.headers.get('retry-after');
        if (response.status === 429 || (response.status === 403 && (remaining === '0' || retry !== null || secondary))) {
          const numeric = retry === null ? NaN : Number(retry);
          const parsed = retry === null ? NaN : Date.parse(retry);
          const retryAt = Number.isFinite(numeric) && numeric >= 0 ? this.now() + numeric * 1000 : Number.isFinite(parsed) ? parsed : this.now() + 60_000;
          this.blockedUntil = Math.max(this.blockedUntil, this.now() + 1_000, retryAt);
          throw new GitHubError('GitHub API rate limit reached. Retry after the displayed time.', response.status, this.blockedUntil);
        }
        const messages: Record<number, string> = {
          401: 'GitHub authentication expired or was revoked. Sign in again.',
          403: 'GitHub denied access. Check repository permissions or organization authorization.',
          404: 'Repository or workflow not found, or this account cannot access it. Private repositories may require additional authorization.',
        };
        throw new GitHubError(messages[response.status] ?? `GitHub request failed (HTTP ${response.status}).`, response.status);
      }
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new GitHubError('GitHub returned invalid JSON.'); }
      const link = response.headers.get('link') ?? '';
      let next: string | null = null;
      for (const match of link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)) {
        if (match[2]!.split(/\s+/).includes('next')) next = this.apiUrl(match[1]!).toString();
      }
      const value = { data, etag: response.headers.get('etag'), next };
      this.cache.set(url, value);
      return value;
    } catch (error) {
      if (signal?.aborted || lifetime.aborted) throw abortError();
      if (timedOut) throw new GitHubError('GitHub request timed out. Try refreshing again.');
      if (error instanceof GitHubError) throw error;
      throw new GitHubError('Could not connect to GitHub. Check your connection and proxy settings.');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      lifetime.removeEventListener('abort', cancel);
    }
  }
}
