import { DEFAULT_FILTERS, type DashboardState, type Filters, type QueueSnapshot } from '../shared/model.js';

interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const clock: Clock = {
  now: Date.now,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export type Collect = (repository: string, viewer: string, signal: AbortSignal) => Promise<QueueSnapshot>;

/** One collection generation owns every result; visibility only schedules future work. */
export class DashboardController {
  readonly state: DashboardState;
  private generation = 0;
  private abort: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private timer: unknown = null;
  private visible = false;
  private focused = true;
  private disposed = false;
  private lastAttempt = 0;
  private failures = 0;
  private autoRetryAt = 0;
  private accountKey: string | null = null;
  constructor(
    private readonly collect: Collect,
    private readonly changed: (state: DashboardState) => void,
    locale: DashboardState['locale'] = 'en',
    private readonly time: Clock = clock,
    private readonly cooldown: () => number | null = () => null,
  ) {
    this.state = { repository: null, account: null, snapshot: null, loading: false, error: null,
      retryAt: null, filters: { ...DEFAULT_FILTERS }, autoRefresh: true, refreshIntervalSeconds: 120,
      locale, discoveryWarnings: [] };
  }
  private emit(): void { if (!this.disposed) this.changed(this.state); }
  private cancel(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.pending = null;
    this.state.loading = false;
    if (this.timer !== null) this.time.clearTimeout(this.timer);
    this.timer = null;
  }
  setRepository(repository: string | null): void {
    if (repository === this.state.repository && !this.state.snapshot?.demo) return;
    this.cancel();
    Object.assign(this.state, { repository, snapshot: null, error: null, retryAt: null, filters: { ...DEFAULT_FILTERS } });
    this.lastAttempt = 0;
    this.failures = 0;
    this.autoRetryAt = 0;
    this.emit();
    this.schedule();
  }
  setIdentity(account: string | null, sessionKey: string | null = account): void {
    if (account === this.state.account && sessionKey === this.accountKey) return;
    const demo = this.state.snapshot?.demo ? this.state.snapshot : null;
    this.cancel();
    this.accountKey = sessionKey;
    Object.assign(this.state, { account, snapshot: demo, error: null, retryAt: null });
    this.lastAttempt = 0;
    this.failures = 0;
    this.autoRetryAt = 0;
    this.emit();
    this.schedule();
  }
  setFilters(filters: Filters): void { this.state.filters = { ...filters }; this.emit(); }
  setDiscoveryWarnings(warnings: string[]): void { this.state.discoveryWarnings = warnings; this.emit(); }
  configure(autoRefresh: boolean, seconds: number): void {
    this.state.autoRefresh = autoRefresh;
    this.state.refreshIntervalSeconds = Math.max(60, Math.min(3600, Number.isFinite(seconds) ? seconds : 120));
    this.emit();
    this.schedule();
  }
  setVisibility(visible: boolean, focused: boolean): void {
    this.visible = visible;
    this.focused = focused;
    this.schedule();
  }
  showDemo(snapshot: QueueSnapshot): void {
    this.cancel();
    Object.assign(this.state, { repository: snapshot.repository, snapshot: { ...snapshot, demo: true },
      error: null, retryAt: null, filters: { ...DEFAULT_FILTERS } });
    this.emit();
  }
  async refresh(manual = true): Promise<void> {
    if (this.disposed || !this.state.repository || this.state.snapshot?.demo) return;
    if (this.pending) return this.pending;
    if (this.state.retryAt && this.time.now() < this.state.retryAt) return;
    if (!manual && this.time.now() < this.autoRetryAt) return;
    if (this.timer !== null) this.time.clearTimeout(this.timer);
    this.timer = null;
    const generation = this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.state.loading = true;
    this.state.error = null;
    this.lastAttempt = this.time.now();
    this.emit();
    const repository = this.state.repository;
    const viewer = this.state.account ?? '';
    // Defer invocation so pending is set even for a synchronously failing collector.
    const task = Promise.resolve().then(() => this.collect(repository, viewer, abort.signal)).then(snapshot => {
      if (generation !== this.generation || abort.signal.aborted) return;
      this.state.snapshot = snapshot;
      this.state.retryAt = this.cooldown();
      this.failures = 0;
      this.autoRetryAt = 0;
    }).catch((error: unknown) => {
      if (generation !== this.generation || abort.signal.aborted) return;
      const fault = error as { name?: string; message?: string; retryAt?: number | null; status?: number };
      if (fault.name === 'AbortError') return;
      this.state.error = fault.message || (this.state.locale === 'zh-cn' ? '采集失败，请稍后重试。' : 'Collection failed. Please try again.');
      this.failures++;
      const wait = Math.min(30 * 60_000, this.state.refreshIntervalSeconds * 1000 * 2 ** Math.min(4, this.failures - 1));
      this.state.retryAt = fault.retryAt ?? null;
      this.autoRetryAt = this.time.now() + wait;
    }).finally(() => {
      if (generation !== this.generation) return;
      this.state.loading = false;
      this.pending = null;
      this.abort = null;
      this.lastAttempt = this.time.now();
      this.emit();
      this.schedule();
    });
    this.pending = task;
    return task;
  }
  private schedule(): void {
    if (this.timer !== null) this.time.clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed || !this.visible || !this.focused || !this.state.autoRefresh || !this.state.repository
      || this.state.snapshot?.demo || this.pending || this.state.loading) return;
    const now = this.time.now();
    const due = Math.max(this.lastAttempt ? this.lastAttempt + this.state.refreshIntervalSeconds * 1000 : now, this.state.retryAt ?? 0, this.autoRetryAt);
    this.timer = this.time.setTimeout(() => { this.timer = null; void this.refresh(false); }, Math.max(0, due - now));
  }
  dispose(): void { this.disposed = true; this.cancel(); }
}
