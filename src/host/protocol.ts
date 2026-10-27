import type { Filters, ViewMessage } from '../shared/model.js';

export function validFilters(value: unknown): value is Filters {
  if (!value || typeof value !== 'object') return false;
  const f = value as Filters;
  return (f.resource === null || (typeof f.resource === 'string' && f.resource.length <= 2048))
    && typeof f.mine === 'boolean' && typeof f.search === 'string' && f.search.length <= 500
    && (f.tab === 'queued' || f.tab === 'running')
    && (f.pr === null || (Number.isSafeInteger(f.pr) && f.pr > 0));
}
export function safeGitHubUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password;
  } catch { return false; }
}
export function parseViewMessage(value: unknown): ViewMessage | null {
  if (!value || typeof value !== 'object') return null;
  const msg = value as Record<string, unknown>;
  if (['ready', 'refresh', 'selectRepository', 'signIn', 'switchAccount', 'enablePrivate', 'demo', 'showLogs'].includes(String(msg.type))) {
    return { type: msg.type } as ViewMessage;
  }
  if (msg.type === 'setFilters' && validFilters(msg.filters)) return { type: 'setFilters', filters: msg.filters };
  if (msg.type === 'openExternal' && safeGitHubUrl(msg.url)) return { type: 'openExternal', url: msg.url };
  return null;
}
