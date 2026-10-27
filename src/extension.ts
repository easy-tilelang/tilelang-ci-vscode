import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { URI } from 'vscode-uri';
import { Collector, GitHubClient, parseRepository } from './core/index.js';
import { discoverRepositories, type DiscoveryResult } from './discovery/index.js';
import { createDemoSnapshot } from './shared/demo.js';
import { DEFAULT_FILTERS, type DashboardState, type Filters, type HostMessage } from './shared/model.js';
import { DashboardController } from './host/controller.js';
import { IdentityCoordinator } from './host/identity.js';
import { parseViewMessage, safeGitHubUrl, validFilters } from './host/protocol.js';
import { QueueTree, personalCounts } from './host/sidebar.js';

export async function activate(context: vscode.ExtensionContext): Promise<{ getState(): DashboardState }> {
  const zh = vscode.env.language.toLowerCase().startsWith('zh');
  const t = (cn: string, en: string): string => zh ? cn : en;
  const output = vscode.window.createOutputChannel('TileLang CI');
  const log = (message: string): void => output.appendLine(`[${new Date().toISOString()}] ${message}`);
  let client = new GitHubClient('');
  let panel: vscode.WebviewPanel | undefined;
  let panelListeners: vscode.Disposable[] = [];
  let disposed = false;
  let discovery: DiscoveryResult = { candidates: [], warnings: [] };
  let discoveryAbort: AbortController | undefined;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  status.name = 'TileLang CI';
  status.command = 'tilelangCI.open';

  const controller = new DashboardController(async (repository, viewer, signal) => {
    const collector = new Collector(client);
    log(`Collect ${repository}`);
    const snapshot = await collector.collect(repository, viewer, signal);
    log(`Snapshot ${repository}: ${snapshot.queues.length} resource groups; queuePartial=${snapshot.queuePartial}; associationPartial=${snapshot.associationPartial}`);
    return snapshot;
  }, state => {
    tree?.refresh();
    if (panel) void panel.webview.postMessage({ type: 'state', state } satisfies HostMessage);
    const settings = vscode.workspace.getConfiguration('tilelangCI');
    if (settings.get('showStatusBar', true) && state.repository) {
      const counts = state.snapshot ? personalCounts(state.snapshot) : null;
      status.text = state.loading ? `$(sync~spin) CI` : counts
        ? `$(pulse) CI: ${counts.queued} ${t('等待', 'queued')} · ${counts.running} ${t('运行', 'running')}`
        : '$(pulse) CI';
      if (state.snapshot?.queuePartial || state.error) status.text += ' $(warning)';
      if (state.snapshot?.demo) status.text += ' DEMO';
      status.tooltip = [state.repository, state.snapshot ? `${t('最近快照', 'Latest snapshot')}: ${new Date(state.snapshot.fetchedAt).toLocaleString()}` : t('尚未采集', 'Not collected yet'),
        t('仅在界面可见时更新；此处为最近快照。', 'Updates while visible; these are the latest snapshot counts.'), state.error ?? ''].filter(Boolean).join('\n');
      status.show();
    } else status.hide();
    treeView?.badge && (treeView.badge = undefined);
  }, zh ? 'zh-cn' : 'en', undefined, () => client.retryAt);
  const tree = new QueueTree(() => controller.state);
  const treeView = vscode.window.createTreeView('tilelangCI.explorer', { treeDataProvider: tree, showCollapseAll: false });
  const updateVisibility = (): void => controller.setVisibility(treeView.visible || !!panel?.visible, vscode.window.state.focused);
  const configure = (): void => {
    const config = vscode.workspace.getConfiguration('tilelangCI');
    controller.configure(config.get('autoRefresh', true), config.get('refreshIntervalSeconds', 120));
    updateVisibility();
  };
  const alertError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : t('操作失败', 'Operation failed');
    // All HTTP errors are sanitized by the transport; never log session or remote URL values.
    log(message);
    void vscode.window.showErrorMessage(`TileLang CI: ${message}`);
  };

  const identity = new IdentityCoordinator<vscode.AuthenticationSession>({
    requestSession: async (scopes, options) => vscode.authentication.getSession('github', scopes, options),
    verify: async (token, signal) => {
      const verifyingClient = new GitHubClient(token);
      try { return (await verifyingClient.get<{ login: string }>('/user', signal)).login; }
      finally { verifyingClient.clear(); }
    },
    apply: (next, login, generation) => {
      client.clear();
      if (disposed) return;
      client = new GitHubClient(next?.accessToken ?? '');
      const demo = controller.state.snapshot?.demo;
      controller.setIdentity(login, `${next?.id ?? 'anonymous'}:${generation}`);
      if (demo) controller.showDemo(createDemoSnapshot(login ?? undefined));
      if (login) log(`GitHub identity connected: ${login}`);
    },
    onError: error => log(error instanceof Error ? error.message : 'GitHub session unavailable'),
  });
  async function connect(interactive: boolean, privateAccess = context.globalState.get('privateAccess', false), switchAccount = false): Promise<void> {
    await identity.connect({ interactive, privateAccess, switchAccount });
    if (interactive && controller.state.account) await context.globalState.update('privateAccess', privateAccess);
  }

  async function enablePrivate(): Promise<void> {
    const action = t('继续授权', 'Continue');
    const answer = await vscode.window.showInformationMessage(t(
      '访问私有仓库需要 GitHub OAuth repo 授权，该授权范围包含写权限。TileLang CI 仅调用读取接口。',
      'Private repositories require GitHub OAuth repo scope, which includes write permissions. TileLang CI only makes read requests.'), action);
    if (answer === action) { await connect(true, true); await controller.refresh(); }
  }

  async function discover(): Promise<void> {
    discoveryAbort?.abort();
    const abort = new AbortController();
    discoveryAbort = abort;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots: URI[] = [];
    const current = vscode.window.activeTextEditor?.document.uri;
    if (current && vscode.workspace.getWorkspaceFolder(current)) roots.push(URI.parse(vscode.Uri.joinPath(current, '..').toString()));
    roots.push(...folders.map(f => URI.parse(f.uri.toString())));
    try {
      const result = await discoverRepositories(roots, {
        stat: async uri => vscode.workspace.fs.stat(vscode.Uri.parse(uri.toString())),
        readFile: async uri => vscode.workspace.fs.readFile(vscode.Uri.parse(uri.toString())),
      }, abort.signal, controller.state.locale);
      if (abort.signal.aborted || disposed) return;
      discovery = result;
      controller.setDiscoveryWarnings(result.warnings);
      log(`Discovered ${result.candidates.length} GitHub repository candidates; ${result.warnings.length} warnings`);
    } catch (error) {
      if (!abort.signal.aborted) {
        discovery = { candidates: [], warnings: [t('仓库发现失败，可手动输入 owner/repo。', 'Discovery failed. Enter owner/repo manually.')] };
        controller.setDiscoveryWarnings(discovery.warnings);
      }
    }
  }

  async function selectRepository(): Promise<void> {
    await discover();
    type Pick = vscode.QuickPickItem & { repository?: string; manual?: boolean };
    const picks: Pick[] = discovery.candidates.map(c => ({ label: c.repository, description: c.remote, detail: c.source, repository: c.repository }));
    const favorites = context.globalState.get<string[]>('repositories', []);
    for (const repository of favorites) if (!picks.some(p => p.repository?.toLowerCase() === repository.toLowerCase())) {
      picks.push({ label: repository, description: t('收藏', 'Saved'), repository });
    }
    picks.push({ label: `$(add) ${t('输入 GitHub 仓库…', 'Enter GitHub repository…')}`, manual: true });
    const selected = await vscode.window.showQuickPick(picks, { title: t('TileLang CI · 选择仓库', 'TileLang CI · Select repository'),
      placeHolder: discovery.warnings.length ? t('发现不完整：仍可选择或手动输入', 'Discovery incomplete: select or enter a repository') : 'owner/repo', matchOnDescription: true, matchOnDetail: true });
    if (!selected) return;
    let repository = selected.repository;
    if (selected.manual) {
      const input = await vscode.window.showInputBox({ title: t('GitHub 仓库', 'GitHub repository'), placeHolder: 'tile-ai/tilelang',
        prompt: t('输入 owner/repo 或 https://github.com/owner/repo', 'Enter owner/repo or https://github.com/owner/repo'),
        validateInput: value => { try { parseRepository(value); return null; } catch { return t('请输入有效的 github.com 仓库', 'Enter a valid github.com repository'); } } });
      if (!input) return;
      repository = parseRepository(input);
    }
    if (!repository) return;
    controller.setRepository(repository);
    await Promise.all([
      context.workspaceState.update('repository', repository),
      context.workspaceState.update('filters', DEFAULT_FILTERS),
      context.globalState.update('repositories', [repository, ...favorites.filter(r => r.toLowerCase() !== repository!.toLowerCase())].slice(0, 30)),
    ]);
    await controller.refresh();
  }

  const openExternal = async (url: unknown): Promise<void> => { if (safeGitHubUrl(url)) await vscode.env.openExternal(vscode.Uri.parse(url)); };
  function attachPanel(next: vscode.WebviewPanel): void {
    panel = next;
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] };
    const nonce = randomBytes(18).toString('base64');
    const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js'));
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.css'));
    panel.webview.html = `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${panel.webview.cspSource} data:; font-src ${panel.webview.cspSource}; connect-src 'none';"><link rel="stylesheet" href="${css}"><title>TileLang CI</title></head><body><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    panelListeners.forEach(d => d.dispose());
    panelListeners = [
      panel.onDidChangeViewState(updateVisibility),
      panel.onDidDispose(() => { panel = undefined; panelListeners.forEach(d => d.dispose()); panelListeners = []; updateVisibility(); }),
      panel.webview.onDidReceiveMessage(async raw => {
        const message = parseViewMessage(raw);
        if (!message) return;
        try {
          switch (message.type) {
            case 'ready': await panel?.webview.postMessage({ type: 'state', state: controller.state } satisfies HostMessage); break;
            case 'refresh': await controller.refresh(); break;
            case 'selectRepository': await selectRepository(); break;
            case 'signIn': await connect(true); await controller.refresh(); break;
            case 'switchAccount': await connect(true, context.globalState.get('privateAccess', false), true); await controller.refresh(); break;
            case 'enablePrivate': await enablePrivate(); break;
            case 'demo': controller.showDemo(createDemoSnapshot(controller.state.account ?? undefined)); break;
            case 'showLogs': output.show(true); break;
            case 'setFilters': controller.setFilters(message.filters); await context.workspaceState.update('filters', message.filters); break;
            case 'openExternal': await openExternal(message.url); break;
          }
        } catch (error) { alertError(error); }
      }),
    ];
    updateVisibility();
  }
  function open(): void {
    if (panel) { panel.reveal(undefined, false); return; }
    attachPanel(vscode.window.createWebviewPanel('tilelangCI.dashboard', 'TileLang CI', vscode.ViewColumn.Active, { enableScripts: true }));
  }
  const actions: Record<string, (...args: any[]) => unknown> = {
    open,
    selectRepository,
    refresh: () => controller.refresh(),
    signIn: async () => { await connect(true); await controller.refresh(); },
    switchAccount: async () => { await connect(true, context.globalState.get('privateAccess', false), true); await controller.refresh(); },
    enablePrivate,
    showLogs: () => output.show(true),
    demo: () => { controller.showDemo(createDemoSnapshot(controller.state.account ?? undefined)); open(); },
    openExternal,
    openFiltered: (filters: Partial<Filters>) => { const next = { ...controller.state.filters, ...filters }; if (validFilters(next)) controller.setFilters(next); open(); },
  };
  context.subscriptions.push(output, status, tree, treeView,
    ...Object.entries(actions).map(([name, action]) => vscode.commands.registerCommand(`tilelangCI.${name}`, async (...args) => {
      try { return await action(...args); } catch (error) { alertError(error); }
    })),
    vscode.window.registerWebviewPanelSerializer('tilelangCI.dashboard', { deserializeWebviewPanel: async next => attachPanel(next) }),
    treeView.onDidChangeVisibility(updateVisibility),
    vscode.window.onDidChangeWindowState(updateVisibility),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('tilelangCI')) configure(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void discover(); }),
    vscode.authentication.onDidChangeSessions(event => {
      if (event.provider.id === 'github' && !disposed) identity.sessionsChanged();
    }),
    { dispose: () => { disposed = true; identity.dispose(); discoveryAbort?.abort(); controller.dispose(); client.clear(); panelListeners.forEach(d => d.dispose()); panel?.dispose(); } },
  );
  const savedRepository = context.workspaceState.get<string>('repository');
  if (savedRepository) { try { controller.setRepository(parseRepository(savedRepository)); } catch { /* Ignore invalid older state. */ } }
  const savedFilters = context.workspaceState.get<Filters>('filters');
  if (validFilters(savedFilters)) controller.setFilters(savedFilters);
  configure();
  // Authentication and remote filesystem availability must never block activation.
  void connect(false).catch(error => log(error instanceof Error ? error.message : 'GitHub session unavailable'));
  void discover().then(() => {
    if (!disposed && !controller.state.repository && discovery.candidates.length === 1) {
      controller.setRepository(discovery.candidates[0].repository);
      void context.workspaceState.update('repository', discovery.candidates[0].repository);
    }
  });
  return { getState: () => JSON.parse(JSON.stringify(controller.state)) as DashboardState };
}

export function deactivate(): void { /* Resources belong to context.subscriptions. */ }
