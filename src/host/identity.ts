export interface IdentitySession {
  readonly id: string;
  readonly accessToken: string;
  readonly account: { readonly id: string; readonly label: string };
}
export type IdentityRequestOptions =
  | { silent: true }
  | { createIfNone: true; clearSessionPreference?: true };
export interface IdentityConnectOptions {
  interactive: boolean;
  privateAccess: boolean;
  switchAccount?: boolean;
}
export interface IdentitySessionsChange<S extends IdentitySession> {
  added?: readonly S[];
  removed?: readonly S[];
  changed?: readonly S[];
}
export interface IdentityDependencies<S extends IdentitySession> {
  requestSession(scopes: string[], options: IdentityRequestOptions): Promise<S | undefined>;
  verify(token: string, signal: AbortSignal): Promise<string>;
  /** The generation changes even when a verified session keeps the same ID. */
  apply(session: S | null, login: string | null, generation: number): void;
  onError?(error: unknown): void;
}
interface Operation<S extends IdentitySession> {
  epoch: number;
  options: IdentityConnectOptions;
  candidate: S | null;
  verification: AbortController | null;
  reconcile: boolean;
}

/** Owns identity transactions independently of VS Code, network transport, or UI state. */
export class IdentityCoordinator<S extends IdentitySession = IdentitySession> {
  private epoch = 0;
  private bindingGeneration = 0;
  private operation: Operation<S> | null = null;
  private current: S | null = null;
  private privateAccess = false;
  private disposed = false;
  // A pending getSession() can return a session removed before its promise resolved.
  private latestTokens = new Map<string, string | null>();

  constructor(private readonly dependencies: IdentityDependencies<S>) {}

  async connect(options: IdentityConnectOptions): Promise<void> {
    if (this.disposed) return;
    this.operation?.verification?.abort();
    const operation: Operation<S> = {
      epoch: ++this.epoch,
      options: { ...options },
      candidate: null,
      verification: null,
      reconcile: false,
    };
    this.operation = operation;
    if (!options.interactive) this.privateAccess = options.privateAccess;
    try {
      await this.run(operation);
    } finally {
      if (this.operation === operation) this.operation = null;
    }
  }

  /**
   * Pass no argument for VS Code's provider-only onDidChangeSessions event. Detailed
   * events are also supported for providers and tests that expose session changes.
   */
  sessionsChanged(event?: IdentitySessionsChange<S>): void {
    if (this.disposed) return;
    const detailed = event !== undefined
      && (event.added !== undefined || event.removed !== undefined || event.changed !== undefined);
    for (const session of event?.removed ?? []) this.latestTokens.set(session.id, null);
    for (const session of [...event?.added ?? [], ...event?.changed ?? []]) this.latestTokens.set(session.id, session.accessToken);

    const invalidated = [...event?.removed ?? [], ...event?.changed ?? []];
    const affectsCurrent = this.current !== null && invalidated.some(session => session.id === this.current!.id);
    const affectsCandidate = this.operation?.candidate !== null && this.operation?.candidate !== undefined
      && invalidated.some(session => session.id === this.operation!.candidate!.id);
    const mustReconcile = !detailed || affectsCurrent || affectsCandidate;
    if (mustReconcile) {
      this.publish(null, null);
      if (this.operation) {
        this.operation.reconcile = true;
        this.operation.verification?.abort();
      } else {
        this.reconcile();
      }
    } else if (!this.current && !this.operation && (event?.added?.length ?? 0) > 0) {
      // A new sign-in elsewhere may become available, but never prompt on its behalf.
      this.reconcile();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.operation?.verification?.abort();
    this.operation = null;
    this.latestTokens.clear();
    this.publish(null, null);
  }

  private active(operation: Operation<S>): boolean {
    return !this.disposed && this.operation === operation && operation.epoch === this.epoch;
  }
  private valid(session: S): boolean {
    if (!session.id || !session.accessToken || !session.account?.id || !session.account.label) return false;
    return !this.latestTokens.has(session.id) || this.latestTokens.get(session.id) === session.accessToken;
  }
  private publish(session: S | null, login: string | null): void {
    this.current = session;
    this.dependencies.apply(session, login, ++this.bindingGeneration);
  }
  private reconcile(): void {
    void this.connect({ interactive: false, privateAccess: this.privateAccess }).catch(error => {
      if (!this.disposed) this.dependencies.onError?.(error);
    });
  }
  private async run(operation: Operation<S>): Promise<void> {
    const scopes = operation.options.privateAccess ? ['read:user', 'repo'] : ['read:user'];
    // A provider event can race login or token verification. Re-query silently rather
    // than trusting an old promise. Bound retries so a faulty provider cannot loop.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.active(operation)) return;
      operation.candidate = null;
      operation.verification = null;
      operation.reconcile = false;
      const options: IdentityRequestOptions = attempt === 0 && operation.options.interactive
        ? { createIfNone: true, ...(operation.options.switchAccount ? { clearSessionPreference: true as const } : {}) }
        : { silent: true };
      const session = await this.dependencies.requestSession([...scopes], options);
      if (!this.active(operation)) return;
      if (operation.reconcile) continue;
      if (!session) { this.publish(null, null); return; }
      if (!this.valid(session)) continue;

      operation.candidate = session;
      const verification = new AbortController();
      operation.verification = verification;
      let login: string;
      try {
        login = await this.dependencies.verify(session.accessToken, verification.signal);
      } catch (error) {
        if (!this.active(operation)) return;
        if (operation.reconcile) continue;
        this.publish(null, null);
        throw error;
      }
      if (!this.active(operation)) return;
      if (operation.reconcile || verification.signal.aborted || !this.valid(session)) continue;
      if (typeof login !== 'string' || !login.trim()) {
        this.publish(null, null);
        throw new Error('GitHub account could not be identified.');
      }
      this.privateAccess = operation.options.privateAccess;
      this.publish(session, login.trim());
      return;
    }
    if (this.active(operation)) {
      this.publish(null, null);
      throw new Error('The GitHub session kept changing. Connect again to retry.');
    }
  }
}
