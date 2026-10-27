import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  allJobs, DEFAULT_FILTERS,
  type DashboardState, type Filters, type HostMessage, type Locale,
  type PullRequest, type QueueGroup, type QueueJob, type QueueSnapshot, type ViewMessage,
} from '../shared/model.js';
import './style.css';

declare function acquireVsCodeApi(): { postMessage(message: ViewMessage): void };

const words = {
  'zh-cn': {
    title: 'CI 资源队列', subtitle: '看清当前等待，找到自己的 PR。', select: '选择仓库', refresh: '刷新队列', refreshing: '正在刷新',
    account: 'GitHub 账号', connect: '连接 GitHub', switchAccount: '切换账号', private: '授权访问私有仓库', demo: '查看演示',
    queued: '排队中', running: '运行中', waitingJobs: '等待作业', runningJobs: '运行作业', resources: '资源组', mine: '我的等待',
    prs: '个 PR', authors: '位已识别作者', jobs: '个作业', myPRs: '我的 PR', noMine: '当前采集结果中没有你的活动 PR。',
    noAccount: '连接 GitHub 后，自动标注你创建的 PR。', allResources: '全部资源', filterResources: '按资源筛选', resource: '资源',
    myOnly: '只看我的', search: '搜索 PR、作业、作者', clear: '清除筛选', pr: 'PR / 任务', workflow: '工作流 / 作业', author: '作者',
    waited: '已等待', rank: '资源内队位', runner: 'Runner', noPR: '未确认 PR', oldHead: '旧提交', merged: '已合入', closed: '已关闭',
    noRank: '尚无资源排位', noRankHelp: '以下工作流或作业尚无足够信息计算资源内顺序。', noJobs: '尚未生成可展示的作业',
    jobsUnavailable: '暂时无法读取作业', unknownResource: '资源标签未知', noCreated: '创建时间未知', workflowState: '工作流状态',
    rankNote: '本仓库可见作业按创建时间排序。实际调度可能受共享 runner、跨仓竞争及并发控制影响。',
    partialQueue: '队列采集不完整：当前队位仅代表已采集作业中的顺序，可能有遗漏。',
    partialPR: '部分 PR 关联未确认：“我的 PR”和作者统计可能有遗漏。',
    updated: '更新于', lastSuccess: '上次成功更新于', auto: '可见时自动刷新', manual: '手动刷新', seconds: '秒',
    notUpdated: '尚未刷新', demoLabel: '演示数据', demoHelp: '当前为离线演示，不代表 GitHub 实时状态。',
    retry: '可重试时间', details: '查看诊断详情', logs: '打开诊断日志', error: '暂时无法更新队列',
    empty: '当前没有等待或运行作业', emptyHelp: '本次采集已完成，可以切换仓库或稍后刷新。',
    noResults: '没有符合当前筛选的作业', noResultsHelp: '调整资源、搜索或“只看我的”筛选。',
    welcome: '在编辑器中查看 GitHub CI 等待顺序', welcomeHelp: '选择一个 GitHub 仓库，按实际 runner 标签查看作业和自己的 PR。',
    loading: '正在整理工作流与作业', loadingHelp: '较大的仓库需要一点时间；刷新期间已有结果会继续保留。',
    earliest: '最早第', position: '位', waiting: '等待', active: '运行', unranked: '无排位', viewJobs: '查看作业',
    filteredPR: '正在查看 PR', untitled: '未命名工作流', unknown: '未知', discovered: '仓库发现提示',
    association: '关联依据', reference: '工作流 PR 引用', head: '提交与仓库匹配', merge: '合并提交匹配', commit: 'GitHub 提交关联',
  },
  en: {
    title: 'CI resource queues', subtitle: 'See what is waiting and where your PRs stand.', select: 'Select repository', refresh: 'Refresh queues', refreshing: 'Refreshing',
    account: 'GitHub account', connect: 'Connect GitHub', switchAccount: 'Switch account', private: 'Authorize private repositories', demo: 'Open demo',
    queued: 'Queued', running: 'Running', waitingJobs: 'Queued jobs', runningJobs: 'Running jobs', resources: 'Resource groups', mine: 'My queued jobs',
    prs: 'PRs', authors: 'identified authors', jobs: 'jobs', myPRs: 'My PRs', noMine: 'No active PRs by you in the collected results.',
    noAccount: 'Connect GitHub to highlight PRs you created.', allResources: 'All resources', filterResources: 'Filter resources', resource: 'Resource',
    myOnly: 'Only mine', search: 'Search PRs, jobs, authors', clear: 'Clear filters', pr: 'PR / task', workflow: 'Workflow / job', author: 'Author',
    waited: 'Waited', rank: 'Position in resource', runner: 'Runner', noPR: 'PR unconfirmed', oldHead: 'Older commit', merged: 'Merged', closed: 'Closed',
    noRank: 'No resource position yet', noRankHelp: 'These workflows or jobs do not have enough information for a resource position.', noJobs: 'No displayable jobs created yet',
    jobsUnavailable: 'Jobs could not be read', unknownResource: 'Resource labels unknown', noCreated: 'Creation time unknown', workflowState: 'Workflow status',
    rankNote: 'Visible jobs in this repository ordered by creation time. Shared runners, other repositories and concurrency controls may affect scheduling.',
    partialQueue: 'Queue collection is incomplete. Positions describe only collected jobs and may omit earlier work.',
    partialPR: 'Some PR associations are unconfirmed. My PRs and author counts may be incomplete.',
    updated: 'Updated', lastSuccess: 'Last successful update', auto: 'Auto-refresh while visible', manual: 'Manual refresh', seconds: 's',
    notUpdated: 'Not refreshed yet', demoLabel: 'DEMO', demoHelp: 'Offline demo data, not the live state on GitHub.',
    retry: 'Retry available', details: 'Show diagnostics', logs: 'Open diagnostic log', error: 'Unable to update queues',
    empty: 'No queued or running jobs', emptyHelp: 'Collection finished. Select another repository or refresh later.',
    noResults: 'No jobs match these filters', noResultsHelp: 'Adjust the resource, search or Only mine filter.',
    welcome: 'Track GitHub CI queues without leaving your editor', welcomeHelp: 'Choose a GitHub repository to see jobs grouped by actual runner labels and highlight your PRs.',
    loading: 'Collecting workflows and jobs', loadingHelp: 'Large repositories may take a moment. Existing results stay visible during refresh.',
    earliest: 'First at', position: '', waiting: 'queued', active: 'running', unranked: 'unranked', viewJobs: 'View jobs',
    filteredPR: 'Showing PR', untitled: 'Unnamed workflow', unknown: 'Unknown', discovered: 'Repository discovery notice',
    association: 'Association', reference: 'Workflow PR reference', head: 'Matching commit and repository', merge: 'Matching merge commit', commit: 'GitHub commit association',
  },
} as const;
type Text = typeof words[Locale];
type Send = (message: ViewMessage) => void;

function RefreshIcon() {
  return <svg className="refresh-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 6.1A8 8 0 0 1 19.8 12M4.2 12a8 8 0 0 0 13.7 5.9" /></svg>;
}

function ExternalLink({ url, send, children, className, title }: { url: string; send: Send; children: React.ReactNode; className?: string; title?: string }) {
  return <a href={url} className={className} title={title} onClick={event => { event.preventDefault(); send({ type: 'openExternal', url }); }}>{children}</a>;
}

function dateTime(value: string | number, locale: Locale) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString(locale === 'zh-cn' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function elapsed(job: QueueJob, now: number, locale: Locale) {
  const created = Date.parse(job.createdAt ?? '');
  if (!Number.isFinite(created)) return '—';
  const started = job.status === 'in_progress' ? Date.parse(job.startedAt ?? '') : Number.NaN;
  const seconds = Math.max(0, Math.floor(((Number.isFinite(started) ? started : now) - created) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (locale === 'zh-cn') {
    if (days) return `${days} 天 ${hours % 24} 小时`;
    if (hours) return `${hours} 小时 ${minutes % 60} 分`;
    return minutes ? `${minutes} 分` : `${seconds} 秒`;
  }
  if (days) return `${days}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return minutes ? `${minutes}m` : `${seconds}s`;
}

function resourceName(group: QueueGroup) {
  const specific = group.labels.filter(label => label !== 'self-hosted');
  return (specific.length ? specific : group.labels).join(' · ');
}

function PRBadges({ pr, t }: { pr: PullRequest | null; t: Text }) {
  if (!pr) return null;
  return <>{pr.merged ? <span className="badge merged">{t.merged}</span> : pr.state === 'closed' ? <span className="badge closed">{t.closed}</span> : null}{pr.staleHead && <span className="badge warning">{t.oldHead}</span>}</>;
}

function Labels({ labels }: { labels: string[] }) {
  return <span className="labels">{labels.map(label => <span className="label" key={label}>{label}</span>)}</span>;
}

function matches(job: QueueJob, filters: Filters): boolean {
  if (filters.mine && !job.own) return false;
  if (filters.pr !== null && job.pr?.number !== filters.pr) return false;
  const query = filters.search.trim().toLocaleLowerCase();
  if (!query) return true;
  return `${job.pr ? `#${job.pr.number} ${job.pr.title} ${job.pr.author}` : ''} ${job.name} ${job.workflow} ${job.labels.join(' ')} ${job.runnerName ?? ''}`.toLocaleLowerCase().includes(query);
}

function MyPRs({ snapshot, t, send, filter, locale }: { snapshot: QueueSnapshot; t: Text; send: Send; filter: (patch: Partial<Filters>) => void; locale: Locale }) {
  const mine = allJobs(snapshot).filter(job => job.own && job.pr);
  const prs = new Map<number, { pr: PullRequest; jobs: QueueJob[]; runs: number }>();
  for (const job of mine) {
    const pr = job.pr!;
    const item = prs.get(pr.number) ?? { pr, jobs: [], runs: 0 };
    item.jobs.push(job);
    prs.set(pr.number, item);
  }
  for (const run of snapshot.unrankedRuns.filter(run => run.own && run.pr)) {
    const pr = run.pr!;
    const item = prs.get(pr.number) ?? { pr, jobs: [], runs: 0 };
    item.runs++;
    prs.set(pr.number, item);
  }
  return <section className="my-section" aria-labelledby="my-pr-heading">
    <div className="section-heading"><h2 id="my-pr-heading">{t.myPRs} <span className="count">{prs.size}</span></h2><span className="muted">{snapshot.viewer ? `@${snapshot.viewer}` : ''}</span></div>
    {prs.size === 0 ? <p className="quiet-empty">{snapshot.viewer ? t.noMine : t.noAccount}</p> : <div className="my-grid">{[...prs.values()].sort((a, b) => b.pr.number - a.pr.number).map(({ pr, jobs, runs }) => {
      const groups = snapshot.queues.map(group => ({ group, queued: group.queued.filter(job => job.pr?.number === pr.number && job.own), running: group.running.filter(job => job.pr?.number === pr.number && job.own) })).filter(group => group.queued.length || group.running.length);
      const unranked = jobs.filter(job => job.rank === null && job.status !== 'in_progress').length + runs;
      return <article className="my-card" key={pr.number}>
        <div className="my-card-top"><ExternalLink url={pr.url} send={send} className="pr-number">#{pr.number}</ExternalLink><PRBadges pr={pr} t={t} /><button className="icon-button push-right" onClick={() => filter({ pr: pr.number })} title={`${t.filteredPR} #${pr.number}`} aria-label={`${t.filteredPR} #${pr.number}`}>↗</button></div>
        <p className="pr-title"><ExternalLink url={pr.url} send={send}>{pr.title}</ExternalLink></p>
        <div className="my-positions">{groups.map(({ group, queued, running }) => <div className="my-position" key={group.key}><span className="resource-caption" title={group.labels.join(' · ')}>{resourceName(group)}</span><span className="position-summary">{queued.length > 0 && <><strong>{locale === 'zh-cn' ? `最早第 ${Math.min(...queued.map(job => job.rank!))} 位` : `First at #${Math.min(...queued.map(job => job.rank!))}`}</strong><span className="muted"> · {queued.length} {t.waiting}</span></>}{running.length > 0 && <span className="running-text">{queued.length ? ' · ' : ''}{running.length} {t.active}</span>}</span></div>)}</div>
        {unranked > 0 && <p className="muted unranked-count">{unranked} {t.unranked}</p>}
        {jobs.length > 0 && <details className="job-details"><summary>{t.viewJobs} <span className="count">{jobs.length}</span></summary><ul>{jobs.map(job => <li key={job.id}><span className={`mini-position ${job.status === 'in_progress' ? 'is-running' : ''}`}>{job.rank !== null ? `#${job.rank}` : job.status === 'in_progress' ? '▶' : '—'}</span><ExternalLink url={job.url || job.runUrl} send={send}>{job.name}</ExternalLink><span className="muted job-resource" title={job.labels.join(' · ')}>{job.labels.filter(label => label !== 'self-hosted').join(' · ')}</span></li>)}</ul></details>}
      </article>;
    })}</div>}
  </section>;
}

function QueueTable({ group, jobs, t, send, now, locale, partial, tab }: { group: QueueGroup; jobs: QueueJob[]; t: Text; send: Send; now: number; locale: Locale; partial: boolean; tab: Filters['tab'] }) {
  return <section className="resource-table" aria-label={resourceName(group)}>
    <div className="group-heading"><h3>{resourceName(group)}</h3><Labels labels={group.labels} /><span className="muted group-count">{jobs.length} {t.jobs}</span></div>
    <div className="table-scroll" tabIndex={0} role="region" aria-label={`${resourceName(group)} ${tab === 'queued' ? t.queued : t.running}`}>
      <table><thead><tr><th className="rank-col">{tab === 'queued' ? t.rank : t.running}</th><th>{t.pr}</th><th>{t.workflow}</th><th>{t.author}</th><th>{t.waited}</th>{tab === 'running' && <th>{t.runner}</th>}</tr></thead>
        <tbody>{jobs.map(job => <tr key={job.id} className={job.own ? 'own-row' : ''}>
          <td><span className={`rank ${job.own ? 'own-rank' : ''} ${tab === 'running' ? 'running-rank' : ''}`} title={partial && job.rank !== null ? t.partialQueue : undefined}>{tab === 'queued' ? <>{job.rank}{partial ? '*' : ''}</> : '▶'}</span></td>
          <td className="pr-cell">{job.pr ? <><div className="cell-line"><ExternalLink url={job.pr.url} send={send} className="pr-number">#{job.pr.number}</ExternalLink><PRBadges pr={job.pr} t={t} />{job.own && <span className="own-mark" title={t.myOnly} aria-label={t.myOnly}>●</span>}</div><ExternalLink url={job.pr.url} send={send} className="cell-title">{job.pr.title}</ExternalLink><span className="association-note" title={`${t.association}: ${t[job.pr.association]}`}>{job.note}</span></> : <><span className="muted">{t.noPR}</span><span className="cell-title">{job.workflow}</span>{job.note && <span className="association-note">{job.note}</span>}</>}</td>
          <td className="workflow-cell"><ExternalLink url={job.runUrl} send={send} className="muted cell-workflow">{job.workflow}</ExternalLink><ExternalLink url={job.url || job.runUrl} send={send} className="cell-title">{job.name}</ExternalLink></td>
          <td className="author-cell">{job.pr?.author ?? '—'}</td><td className="wait-cell" title={job.createdAt ? dateTime(job.createdAt, locale) : t.noCreated}>{elapsed(job, now, locale)}</td>{tab === 'running' && <td className="runner-cell">{job.runnerName || t.unknown}</td>}
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

function Unranked({ snapshot, filters, t, send, locale }: { snapshot: QueueSnapshot; filters: Filters; t: Text; send: Send; locale: Locale }) {
  const jobs = snapshot.heldJobs.filter(job => matches(job, filters));
  const query = filters.search.trim().toLocaleLowerCase();
  const runs = snapshot.unrankedRuns.filter(run => (!filters.mine || run.own) && (filters.pr === null || filters.pr === run.pr?.number) && (!query || `${run.name} ${run.pr?.number ?? ''} ${run.pr?.title ?? ''} ${run.pr?.author ?? ''}`.toLocaleLowerCase().includes(query)));
  if (!jobs.length && !runs.length) return null;
  return <section className="unranked-section" aria-labelledby="unranked-heading"><div className="section-heading"><h2 id="unranked-heading">{t.noRank} <span className="count">{jobs.length + runs.length}</span></h2></div><p className="section-description">{t.noRankHelp}</p><div className="unranked-list">
    {jobs.map(job => <article className={`unranked-item ${job.own ? 'own-unranked' : ''}`} key={`job-${job.id}`}><span className="unknown-dot" aria-hidden="true">◇</span><div className="unranked-main"><ExternalLink url={job.url || job.runUrl} send={send}>{job.name}</ExternalLink><span className="muted">{job.workflow} · {job.status}</span><span className="muted">{job.note || (!job.labels.length ? t.unknownResource : !job.createdAt ? t.noCreated : t.noRank)}</span></div>{job.pr && <div className="unranked-pr"><ExternalLink url={job.pr.url} send={send}>#{job.pr.number}</ExternalLink><PRBadges pr={job.pr} t={t} /></div>}</article>)}
    {runs.map(run => <article className={`unranked-item ${run.own ? 'own-unranked' : ''}`} key={`run-${run.id}`}><span className="unknown-dot" aria-hidden="true">◇</span><div className="unranked-main"><ExternalLink url={run.url} send={send}>{run.name || t.untitled}</ExternalLink><span className="muted">{t.workflowState}: {run.status} · {run.reason === 'jobs-unavailable' ? t.jobsUnavailable : t.noJobs}</span>{run.createdAt && <time className="muted" dateTime={run.createdAt}>{dateTime(run.createdAt, locale)}</time>}</div>{run.pr && <div className="unranked-pr"><ExternalLink url={run.pr.url} send={send}>#{run.pr.number}</ExternalLink><PRBadges pr={run.pr} t={t} /></div>}</article>)}
  </div></section>;
}

export function Dashboard({ state, send, onFilter }: { state: DashboardState; send: Send; onFilter: (filters: Filters) => void }) {
  const { snapshot, locale } = state;
  const t = words[locale];
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), state.retryAt ? 1000 : 30000); return () => window.clearInterval(timer); }, [state.retryAt]);
  const filter = (patch: Partial<Filters>) => onFilter({ ...state.filters, ...patch });
  const jobs = useMemo(() => snapshot ? allJobs(snapshot) : [], [snapshot]);
  const queued = snapshot?.queues.reduce((sum, group) => sum + group.queued.length, 0) ?? 0;
  const running = snapshot?.queues.reduce((sum, group) => sum + group.running.length, 0) ?? 0;
  const prs = new Set([...jobs.map(job => job.pr?.number), ...(snapshot?.unrankedRuns.map(run => run.pr?.number) ?? [])].filter(number => number !== undefined));
  const authors = new Set([...jobs.map(job => job.pr?.author.toLowerCase()), ...(snapshot?.unrankedRuns.map(run => run.pr?.author.toLowerCase()) ?? [])].filter(Boolean));
  const myQueued = snapshot?.queues.reduce((sum, group) => sum + group.queued.filter(job => job.own).length, 0) ?? 0;
  const filteredGroups = snapshot?.queues.filter(group => !state.filters.resource || group.key === state.filters.resource).map(group => ({ group, jobs: group[state.filters.tab === 'queued' ? 'queued' : 'running'].filter(job => matches(job, state.filters)) })).filter(group => group.jobs.length) ?? [];
  const hasFilters = state.filters.resource !== null || state.filters.mine || Boolean(state.filters.search) || state.filters.pr !== null;
  const blocked = state.retryAt !== null && state.retryAt > now;
  const hasUnranked = Boolean(snapshot?.heldJobs.length || snapshot?.unrankedRuns.length);
  return <main className="dashboard" lang={locale === 'zh-cn' ? 'zh-CN' : 'en'} aria-busy={state.loading}>
    <header className="page-header"><div><div className="eyebrow">TILELANG CI <span className="header-separator">/</span> GITHUB ACTIONS</div><h1>{t.title}</h1><p className="subtitle">{t.subtitle}</p></div><div className="header-actions"><button className="button secondary repository-select" onClick={() => send({ type: 'selectRepository' })}><span className="repo-symbol" aria-hidden="true">⌘</span><span>{state.repository || t.select}</span><span className="muted" aria-hidden="true">⌄</span></button><button className={`button primary refresh-button ${state.loading ? 'loading' : ''}`} onClick={() => send({ type: 'refresh' })} disabled={!state.repository || state.loading || blocked}><RefreshIcon /><span>{state.loading ? t.refreshing : t.refresh}</span></button></div></header>
    <div className="meta-bar"><div className="account-block">{state.account ? <button className="text-button account-button" onClick={() => send({ type: 'switchAccount' })} title={t.switchAccount}><span className="connection-dot" />@{state.account}</button> : <button className="text-button" onClick={() => send({ type: 'signIn' })}>{t.connect} ↗</button>}<span className="meta-divider">·</span><span>{state.autoRefresh ? `${t.auto} · ${state.refreshIntervalSeconds}${t.seconds}` : t.manual}</span></div><span className="updated-at">{snapshot ? `${state.error ? t.lastSuccess : t.updated} ${dateTime(snapshot.fetchedAt, locale)}` : t.notUpdated}</span></div>

    {snapshot?.demo && <div className="notice demo-notice" role="status"><span className="badge demo-badge">{t.demoLabel}</span><span>{t.demoHelp}</span><button className="text-button push-right" onClick={() => send({ type: 'selectRepository' })}>{t.select} →</button></div>}
    {state.error && <div className="notice error-notice" role="alert"><div><strong>{t.error}</strong><p>{state.error}</p>{state.retryAt !== null && <p>{t.retry}: {dateTime(state.retryAt, locale)}</p>}</div><div className="notice-actions"><button className="button secondary" onClick={() => send({ type: 'enablePrivate' })}>{t.private}</button><button className="text-button" onClick={() => send({ type: 'showLogs' })}>{t.logs}</button></div></div>}
    {snapshot?.queuePartial && <div className="notice warning-notice" role="status">{t.partialQueue}</div>}
    {snapshot?.associationPartial && <div className="notice warning-notice" role="status">{t.partialPR}</div>}
    {(snapshot?.diagnostics.length || state.discoveryWarnings.length) ? <details className="diagnostics"><summary>{t.details} <span className="count">{(snapshot?.diagnostics.length ?? 0) + state.discoveryWarnings.length}</span></summary><ul>{state.discoveryWarnings.map((warning, i) => <li key={`discovery-${i}`}>{t.discovered}: {warning}</li>)}{snapshot?.diagnostics.map((diagnostic, i) => <li key={`snapshot-${i}`}>{diagnostic.message}</li>)}</ul><button className="text-button" onClick={() => send({ type: 'showLogs' })}>{t.logs}</button></details> : null}

    {!snapshot ? <section className="welcome" aria-live="polite"><span className={`welcome-symbol ${state.loading ? 'is-loading' : ''}`} aria-hidden="true">{state.loading ? <RefreshIcon /> : '▦'}</span><h2>{state.loading ? t.loading : t.welcome}</h2><p>{state.loading ? t.loadingHelp : t.welcomeHelp}</p>{!state.loading && <div className="welcome-actions"><button className="button primary" onClick={() => send({ type: 'selectRepository' })}>{t.select}</button>{!state.account && <button className="button secondary" onClick={() => send({ type: 'signIn' })}>{t.connect}</button>}<button className="text-button" onClick={() => send({ type: 'demo' })}>{t.demo} →</button></div>}</section> : <>
      <section className="overview" aria-label={t.title}><article className="stat"><span>{t.waitingJobs}{snapshot.queuePartial ? ' *' : ''}</span><strong>{queued}</strong><small>{prs.size} {t.prs} <span className="dot-divider">·</span> {authors.size} {t.authors}</small></article><article className="stat"><span>{t.runningJobs}{snapshot.queuePartial ? ' *' : ''}</span><strong className="running-text">{running}</strong><small>{t.running}</small></article><article className="stat"><span>{t.resources}</span><strong>{snapshot.queues.length}</strong><small>runner labels</small></article><article className="stat own-stat"><span><span className="own-dot" />{t.mine}{snapshot.queuePartial || snapshot.associationPartial ? ' *' : ''}</span><strong>{myQueued}</strong><small>{snapshot.viewer ? `@${snapshot.viewer}` : t.noAccount}</small></article></section>
      <MyPRs snapshot={snapshot} t={t} send={send} filter={filter} locale={locale} />
      <section className="queue-section" aria-labelledby="queues-heading"><div className="section-heading"><h2 id="queues-heading">{t.filterResources}</h2>{state.filters.resource && <button className="text-button" onClick={() => filter({ resource: null })}>{t.allResources} ↗</button>}</div>
        <div className="resource-list" role="group" aria-label={t.filterResources}><button className={`resource-card all-card ${state.filters.resource === null ? 'selected' : ''}`} aria-pressed={state.filters.resource === null} onClick={() => filter({ resource: null })}><span className="resource-card-title">{t.allResources}</span><span className="resource-label-caption">{snapshot.queues.length} {t.resources}</span><span className="resource-counts"><strong>{queued}</strong> {t.waiting}<span className="push-right running-text">{running} {t.active}</span></span></button>{snapshot.queues.map(group => <button key={group.key} className={`resource-card ${state.filters.resource === group.key ? 'selected' : ''}`} aria-pressed={state.filters.resource === group.key} title={group.labels.join(' · ')} onClick={() => filter({ resource: state.filters.resource === group.key ? null : group.key })}><span className="resource-card-title">{resourceName(group)}</span><span className="resource-label-caption">{group.labels.join(' · ')}</span><span className="resource-counts"><strong>{group.queued.length}</strong> {t.waiting}<span className="push-right running-text">{group.running.length} {t.active}</span></span><span className="resource-mine">{group.queued.some(job => job.own) ? `${t.mine} ${group.queued.filter(job => job.own).length}` : '\u00a0'}</span></button>)}</div>
        <div className="queue-toolbar"><div className="tabs" role="tablist" aria-label={t.title}><button id="queued-tab" role="tab" aria-selected={state.filters.tab === 'queued'} aria-controls="queue-results" tabIndex={state.filters.tab === 'queued' ? 0 : -1} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); filter({ tab: 'running' }); document.getElementById('running-tab')?.focus(); } }} onClick={() => filter({ tab: 'queued' })}>{t.queued}<span className="count">{queued}</span></button><button id="running-tab" role="tab" aria-selected={state.filters.tab === 'running'} aria-controls="queue-results" tabIndex={state.filters.tab === 'running' ? 0 : -1} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); filter({ tab: 'queued' }); document.getElementById('queued-tab')?.focus(); } }} onClick={() => filter({ tab: 'running' })}>{t.running}<span className="count">{running}</span></button></div><div className="filter-controls"><label className="mine-check"><input type="checkbox" checked={state.filters.mine} onChange={event => filter({ mine: event.target.checked })} />{t.myOnly}</label><input type="search" className="search" aria-label={t.search} placeholder={t.search} value={state.filters.search} onChange={event => filter({ search: event.target.value })} /></div></div>
        {hasFilters && <div className="active-filters">{state.filters.pr !== null && <span className="filter-chip">{t.filteredPR} #{state.filters.pr}<button className="icon-button" aria-label={t.clear} onClick={() => filter({ pr: null })}>×</button></span>}<button className="text-button push-right" onClick={() => onFilter({ ...DEFAULT_FILTERS, tab: state.filters.tab })}>{t.clear}</button></div>}
        <div id="queue-results" role="tabpanel" aria-labelledby={state.filters.tab === 'queued' ? 'queued-tab' : 'running-tab'} className="queue-results">{filteredGroups.length ? filteredGroups.map(({ group, jobs: visible }) => <QueueTable key={group.key} group={group} jobs={visible} t={t} send={send} now={now} locale={locale} partial={snapshot.queuePartial} tab={state.filters.tab} />) : <div className="empty-state"><span aria-hidden="true">{hasFilters ? '⌕' : '✓'}</span><h3>{hasFilters || queued + running > 0 || hasUnranked ? t.noResults : t.empty}</h3><p>{hasFilters || queued + running > 0 || hasUnranked ? t.noResultsHelp : t.emptyHelp}</p></div>}</div>
      </section>
      <Unranked snapshot={snapshot} filters={state.filters} t={t} send={send} locale={locale} />
    </>}
    <footer className="page-footer"><span className="info-symbol" aria-hidden="true">ⓘ</span><p>{t.rankNote}</p></footer>
  </main>;
}

const initialState: DashboardState = {
  repository: null, account: null, snapshot: null, loading: false, error: null, retryAt: null,
  filters: DEFAULT_FILTERS, autoRefresh: true, refreshIntervalSeconds: 120, locale: 'zh-cn', discoveryWarnings: [],
};

export function App() {
  const [state, setState] = useState<DashboardState>(initialState);
  const [bridge] = useState(() => acquireVsCodeApi());
  useEffect(() => {
    const listener = (event: MessageEvent<HostMessage>) => { if (event.data?.type === 'state' && event.data.state) setState(event.data.state); };
    window.addEventListener('message', listener);
    bridge.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, [bridge]);
  const send: Send = message => bridge.postMessage(message);
  return <Dashboard state={state} send={send} onFilter={filters => { setState(previous => ({ ...previous, filters })); send({ type: 'setFilters', filters }); }} />;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
