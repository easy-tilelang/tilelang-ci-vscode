import * as vscode from 'vscode';
import { allJobs, type DashboardState, type Filters, type QueueSnapshot } from '../shared/model.js';

class Node extends vscode.TreeItem {
  constructor(label: string, readonly kind: string, readonly key?: string) {
    super(label, ['resources', 'prs', 'unranked'].includes(kind) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.contextValue = kind;
    this.id = `${kind}:${key ?? label}`;
  }
}
export class QueueTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly getState: () => DashboardState) {}
  refresh(): void { this.emitter.fire(undefined); }
  getTreeItem(node: Node): Node { return node; }
  getChildren(parent?: Node): Node[] {
    const state = this.getState();
    const zh = state.locale === 'zh-cn';
    const t = (cn: string, en: string): string => zh ? cn : en;
    const snapshot = state.snapshot;
    if (parent?.kind === 'resources' && snapshot) return snapshot.queues.map(q => {
      const node = new Node(q.labels.join(' · '), 'resource', q.key);
      node.description = t(`${q.queued.length} 等待 · ${q.running.length} 运行`, `${q.queued.length} queued · ${q.running.length} running`);
      node.tooltip = `${q.labels.join(' + ')}\n${snapshot.queuePartial ? t('部分结果：队位可能有遗漏', 'Partial results: positions may be incomplete') : ''}`;
      node.iconPath = new vscode.ThemeIcon('server');
      node.command = this.open({ resource: q.key, pr: null });
      return node;
    });
    if (parent?.kind === 'prs' && snapshot) {
      const jobs = allJobs(snapshot).filter(j => j.own && j.pr);
      const numbers = [...new Set([...jobs.map(j => j.pr!.number), ...snapshot.unrankedRuns.filter(r => r.own && r.pr).map(r => r.pr!.number)])];
      if (!numbers.length) return [new Node(t('没有已识别的活动 PR', 'No identified active PRs'), 'empty')];
      return numbers.map(number => {
        const entries = jobs.filter(j => j.pr?.number === number);
        const pr = entries[0]?.pr ?? snapshot.unrankedRuns.find(r => r.pr?.number === number)?.pr;
        const node = new Node(`#${number} ${pr?.title ?? ''}`, 'pr', String(number));
        node.iconPath = new vscode.ThemeIcon(pr?.merged ? 'git-merge' : pr?.state === 'closed' ? 'git-pull-request-closed' : 'git-pull-request');
        const summaries = snapshot.queues.flatMap(q => {
          const own = q.queued.filter(j => j.pr?.number === number);
          return own.length ? [`${q.labels.join(' + ')}: ${t('最早第', 'first #')}${Math.min(...own.map(j => j.rank!))}${t(' 位', '')} · ${own.length}`] : [];
        });
        node.description = entries.length
          ? `${entries.filter(j => j.status === 'queued').length} ${t('等待', 'queued')} · ${entries.filter(j => j.status === 'in_progress').length} ${t('运行', 'running')}`
          : t('尚无资源排位', 'No resource position');
        node.tooltip = [pr?.title ?? '', ...summaries, pr?.merged ? t('已合入，相关作业仍在活动中', 'Merged; associated jobs are still active') : ''].filter(Boolean).join('\n');
        node.command = this.open({ pr: number, resource: null, mine: true });
        return node;
      });
    }
    if (parent?.kind === 'unranked' && snapshot) {
      return [
        ...snapshot.heldJobs.map(j => {
          const node = new Node(j.name, 'held', String(j.id));
          node.description = j.status;
          node.tooltip = j.note ?? t('标签或时间不足，暂不排位', 'Missing resource or time; no position assigned');
          node.command = { command: 'tilelangCI.openExternal', title: 'GitHub', arguments: [j.url] };
          return node;
        }),
        ...snapshot.unrankedRuns.map(r => {
          const node = new Node(r.name, 'run', String(r.id));
          node.description = r.status;
          node.tooltip = t('尚无可展示作业，等待原因以 GitHub 为准', 'No available jobs; see GitHub for workflow status');
          node.command = { command: 'tilelangCI.openExternal', title: 'GitHub', arguments: [r.url] };
          return node;
        }),
      ];
    }
    if (parent) return [];
    const repository = new Node(state.repository ?? t('选择 GitHub 仓库', 'Select a GitHub repository'), 'repository');
    repository.iconPath = new vscode.ThemeIcon('repo');
    repository.command = { command: 'tilelangCI.selectRepository', title: 'Select' };
    const account = new Node(state.account ? `@${state.account}` : t('连接 GitHub', 'Connect GitHub'), 'account');
    account.iconPath = new vscode.ThemeIcon('github');
    account.command = { command: state.account ? 'tilelangCI.switchAccount' : 'tilelangCI.signIn', title: 'GitHub' };
    const result = [repository, account];
    if (snapshot?.demo) {
      const demo = new Node(t('演示数据 · 选择仓库退出', 'DEMO · select a repository to exit'), 'demo');
      demo.iconPath = new vscode.ThemeIcon('beaker');
      demo.command = { command: 'tilelangCI.selectRepository', title: 'Select' };
      result.push(demo);
    }
    if (state.loading) {
      const loading = new Node(t('正在刷新…', 'Refreshing…'), 'loading');
      loading.iconPath = new vscode.ThemeIcon('sync~spin');
      result.push(loading);
    }
    if (state.error) {
      const error = new Node(t('更新失败，查看诊断', 'Update failed — diagnostics'), 'error');
      error.tooltip = state.error;
      error.iconPath = new vscode.ThemeIcon('warning');
      error.command = { command: 'tilelangCI.showLogs', title: 'Diagnostics' };
      result.push(error);
    }
    if (snapshot) {
      const resources = new Node(t('资源队列', 'Resources'), 'resources');
      resources.description = String(snapshot.queues.length);
      const prs = new Node(t('我的 PR', 'My PRs'), 'prs');
      const unranked = new Node(t('尚无资源排位', 'Without a resource position'), 'unranked');
      unranked.description = String(snapshot.heldJobs.length + snapshot.unrankedRuns.length);
      result.push(resources, prs);
      if (snapshot.heldJobs.length || snapshot.unrankedRuns.length) result.push(unranked);
      const update = new Node(t('打开完整看板', 'Open full dashboard'), 'open');
      update.description = new Date(snapshot.fetchedAt).toLocaleTimeString();
      update.tooltip = `${t('最近快照', 'Latest snapshot')}: ${snapshot.fetchedAt}`;
      update.command = { command: 'tilelangCI.open', title: 'Dashboard' };
      update.iconPath = new vscode.ThemeIcon('dashboard');
      result.push(update);
    } else {
      const open = new Node(t('打开看板', 'Open dashboard'), 'open');
      open.command = { command: 'tilelangCI.open', title: 'Dashboard' };
      const demo = new Node(t('打开演示', 'Open demo'), 'demo');
      demo.command = { command: 'tilelangCI.demo', title: 'Demo' };
      demo.iconPath = new vscode.ThemeIcon('beaker');
      result.push(open, demo);
    }
    return result;
  }
  private open(filters: Partial<Filters>): vscode.Command {
    return { command: 'tilelangCI.openFiltered', title: 'Dashboard', arguments: [filters] };
  }
  dispose(): void { this.emitter.dispose(); }
}

export function personalCounts(snapshot: QueueSnapshot): { queued: number; running: number } {
  return { queued: snapshot.queues.reduce((n, q) => n + q.queued.filter(j => j.own).length, 0),
    running: snapshot.queues.reduce((n, q) => n + q.running.filter(j => j.own).length, 0) };
}
