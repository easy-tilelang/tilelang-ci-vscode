import { URI } from 'vscode-uri';

/** The numeric file type flags deliberately match VS Code's FileType. */
export interface DiscoveryFileSystem {
  stat(uri: URI): Promise<{ type: number; size?: number }>;
  readFile(uri: URI): Promise<Uint8Array>;
}
export interface RepositorySource {
  root: URI;
  remote: string;
  source: string;
}
export interface RepositoryCandidate extends RepositorySource {
  repository: string;
  sources: RepositorySource[];
}
export interface DiscoveryResult {
  candidates: RepositoryCandidate[];
  warnings: string[];
}
export interface GitConfiguration {
  remotes: Array<{ name: string; url: string }>;
  worktreeConfig: boolean | null;
  incomplete: boolean;
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PARENTS = 32;
const IO_TIMEOUT_MS = 10_000;
const FILE = 1;
const DIRECTORY = 2;
const WARNINGS = {
  'zh-cn': {
    inaccessible: '部分工作区的 Git 元数据不可读取，可手动指定仓库。',
    invalid: '已发现 Git 仓库，但元数据不可读取或格式不受支持，请手动指定仓库。',
    partial: '部分 Git include、条件配置或 URL rewrite 未解析，请确认仓库选择。',
    remote: '部分 remote 不是可直接识别的 GitHub 地址，SSH 别名或自定义地址请手动指定仓库。',
  },
  en: {
    inaccessible: 'Git metadata in some workspace folders could not be read. You can enter a repository manually.',
    invalid: 'A Git repository was found, but its metadata could not be read or is unsupported. Enter the repository manually.',
    partial: 'Some Git includes, conditional configuration, or URL rewrites were not resolved. Confirm the repository selection.',
    remote: 'Some remotes are not directly recognizable GitHub URLs. Specify repositories for SSH aliases or custom addresses manually.',
  },
};

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Discovery cancelled', 'AbortError');
}
function readIo<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  abort(signal);
  return new Promise<T>((resolve, reject) => {
    const done = (callback: () => void) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancelled);
      callback();
    };
    const cancelled = () => done(() => reject(new DOMException('Discovery cancelled', 'AbortError')));
    const timeout = setTimeout(() => done(() => reject(new Error('Git metadata read timed out'))), IO_TIMEOUT_MS);
    signal?.addEventListener('abort', cancelled, { once: true });
    Promise.resolve().then(() => { abort(signal); return operation(); })
      .then(value => done(() => resolve(value)), error => done(() => reject(error)));
  });
}
function cleanUri(uri: URI): URI {
  return uri.with({ query: '', fragment: '' });
}
function windowsPath(uri: URI): boolean {
  return /^\/[A-Za-z]:\//.test(uri.path);
}
function normalizedPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}
function join(base: URI, relative: string): URI {
  return cleanUri(base).with({ path: normalizedPath(`${base.path}/${relative}`) });
}
function parent(uri: URI): URI {
  const withoutSlash = uri.path.replace(/\/+$/, '');
  if (!withoutSlash || /^\/[A-Za-z]:$/.test(withoutSlash)) return uri.with({ path: withoutSlash || '/' });
  return uri.with({ path: withoutSlash.slice(0, withoutSlash.lastIndexOf('/')) || '/' });
}

/** Resolve Git's filesystem paths without turning a remote URI into a local URI. */
export function resolveGitPath(base: URI, value: string): URI {
  if (!value || /[\0\r\n]/.test(value) || value.startsWith('//') || value.startsWith('\\\\')) {
    throw new Error('Unsupported Git metadata path');
  }
  let path = value;
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    path = `/${path.replace(/\\/g, '/')}`;
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) {
    throw new Error('Git metadata cannot change the URI origin');
  } else if (windowsPath(base)) {
    path = path.replace(/\\/g, '/');
  }
  const absolute = path.startsWith('/') ? path : `${base.path}/${path}`;
  return cleanUri(base).with({ path: normalizedPath(absolute) });
}

function logicalLines(text: string): string[] {
  const lines: string[] = [];
  let line = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '\0') throw new Error('Invalid Git configuration');
    if (char === '\\') {
      if (text[i + 1] === '\n') { i++; continue; }
      if (text[i + 1] === '\r' && text[i + 2] === '\n') { i += 2; continue; }
      line += char;
      if (i + 1 < text.length) line += text[++i];
      continue;
    }
    if (!quoted && (char === '#' || char === ';')) {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      i--;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === '\n' || char === '\r') {
      if (quoted) throw new Error('Unterminated Git configuration quote');
      if (char === '\r' && text[i + 1] === '\n') i++;
      if (line.trim()) lines.push(line);
      line = '';
    } else line += char;
  }
  if (quoted) throw new Error('Unterminated Git configuration quote');
  if (line.trim()) lines.push(line);
  return lines;
}
function valueText(value: string): string {
  const chars: Array<{ text: string; quoted: boolean }> = [];
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    let char = value[i]!;
    if (char === '"') { quoted = !quoted; continue; }
    if (char === '\\') {
      const next = value[++i];
      const escapes: Record<string, string> = { n: '\n', t: '\t', b: '\b', '\\': '\\', '"': '"' };
      if (!next || !(next in escapes)) throw new Error('Invalid Git configuration escape');
      char = escapes[next]!;
    }
    chars.push({ text: char, quoted });
  }
  if (quoted) throw new Error('Unterminated Git configuration quote');
  while (chars.length && !chars[0]!.quoted && /\s/.test(chars[0]!.text)) chars.shift();
  while (chars.length && !chars[chars.length - 1]!.quoted && /\s/.test(chars[chars.length - 1]!.text)) chars.pop();
  return chars.map(char => char.text).join('');
}
function subsectionText(value: string): string {
  return value.replace(/\\(.)/g, (_match, char: string) => {
    if (char !== '\\' && char !== '"') throw new Error('Invalid Git subsection escape');
    return char;
  });
}

/** Parse Git syntax, not generic INI: quoted subsections, comments and continuations matter. */
export function parseGitConfig(text: string): GitConfiguration {
  const config: GitConfiguration = { remotes: [], worktreeConfig: null, incomplete: false };
  let section = '';
  let subsection: string | null = null;
  for (const rawLine of logicalLines(text.replace(/^\uFEFF/, ''))) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      const match = /^\[([A-Za-z0-9][A-Za-z0-9.-]*)(?:\s+"((?:\\.|[^"\\])*)")?\s*\]$/.exec(line);
      if (!match) throw new Error('Invalid Git configuration section');
      section = match[1]!.toLowerCase();
      subsection = match[2] !== undefined ? subsectionText(match[2]) : null;
      if (subsection === null && section.includes('.')) {
        const dot = section.indexOf('.');
        subsection = section.slice(dot + 1);
        section = section.slice(0, dot);
      }
      if (section === 'include' || section === 'includeif' || section === 'url') config.incomplete = true;
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*(.*))?$/.exec(line);
    if (!section || !match) throw new Error('Invalid Git configuration entry');
    const key = match[1]!.toLowerCase();
    const value = match[2] === undefined ? 'true' : valueText(match[2]);
    if (section === 'remote' && subsection !== null && key === 'url') {
      config.remotes.push({ name: subsection, url: value });
    }
    if (section === 'extensions' && key === 'worktreeconfig') {
      if (!/^(true|yes|on|1|false|no|off|0|)$/i.test(value)) throw new Error('Invalid Git boolean');
      config.worktreeConfig = /^(true|yes|on|1)$/i.test(value);
    }
  }
  return config;
}

/** Return only a canonical repository; never expose an embedded remote credential. */
export function parseRemote(value: string): string | null {
  const input = value.trim();
  if (!input || /[\0\r\n\s]/.test(input)) return null;
  let path: string;
  const scp = /^git@github\.com:([^?#]+)$/i.exec(input);
  if (scp) path = scp[1]!;
  else {
    let uri: URL;
    try { uri = new URL(input); } catch { return null; }
    if (uri.search || uri.hash) return null;
    const host = uri.hostname.toLowerCase();
    if (uri.protocol === 'https:') {
      if (host !== 'github.com' || uri.port) return null;
    } else if (uri.protocol === 'ssh:') {
      if (uri.username !== 'git' || uri.password) return null;
      if (host === 'github.com') { if (uri.port && uri.port !== '22') return null; }
      else if (host !== 'ssh.github.com' || uri.port !== '443') return null;
    } else return null;
    path = uri.pathname.replace(/^\//, '');
  }
  path = path.replace(/\/$/, '').replace(/\.git$/i, '');
  const parts = path.split('/');
  if (parts.length !== 2) return null;
  try { parts[0] = decodeURIComponent(parts[0]!); parts[1] = decodeURIComponent(parts[1]!); } catch { return null; }
  const [owner, repository] = parts;
  if (!owner || !repository || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)
    || !/^[A-Za-z0-9_.-]+$/.test(repository) || repository === '.' || repository === '..') return null;
  return `${owner}/${repository}`;
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && /^(?:ENOENT|FileNotFound|EntryNotFound)(?:\b|$)/.test(String(error.code));
}
async function optionalStat(fs: DiscoveryFileSystem, uri: URI, signal?: AbortSignal) {
  abort(signal);
  try { const result = await readIo(() => fs.stat(uri), signal); abort(signal); return result; }
  catch (error) { abort(signal); if (missing(error)) return null; throw error; }
}
async function readText(fs: DiscoveryFileSystem, uri: URI, signal?: AbortSignal): Promise<string> {
  abort(signal);
  const info = await readIo(() => fs.stat(uri), signal);
  if (!(info.type & FILE) || (info.size !== undefined && info.size > MAX_FILE_BYTES)) throw new Error('Invalid Git metadata size or type');
  const bytes = await readIo(() => fs.readFile(uri), signal);
  abort(signal);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('Git metadata is too large');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
async function findRoot(start: URI, fs: DiscoveryFileSystem, signal?: AbortSignal): Promise<URI | null> {
  let current = cleanUri(start);
  for (let depth = 0; depth < MAX_PARENTS; depth++) {
    const info = await optionalStat(fs, join(current, '.git'), signal);
    if (info) return current;
    const next = parent(current);
    if (next.path === current.path) return null;
    current = next;
  }
  return null;
}
async function readConfiguration(root: URI, fs: DiscoveryFileSystem, signal?: AbortSignal): Promise<GitConfiguration> {
  const dotGit = join(root, '.git');
  const dotGitInfo = await readIo(() => fs.stat(dotGit), signal);
  let gitDir: URI;
  if (dotGitInfo.type & DIRECTORY) gitDir = dotGit;
  else if (dotGitInfo.type & FILE) {
    const pointer = (await readText(fs, dotGit, signal)).trim();
    const match = /^gitdir:\s*([^\r\n]+)$/.exec(pointer);
    if (!match) throw new Error('Invalid gitdir pointer');
    gitDir = resolveGitPath(root, match[1]!.trim());
  } else throw new Error('Unsupported .git type');
  if (!((await readIo(() => fs.stat(gitDir), signal)).type & DIRECTORY)) throw new Error('gitdir does not point to a directory');
  const commonPointer = join(gitDir, 'commondir');
  const commonInfo = await optionalStat(fs, commonPointer, signal);
  const commonDir = commonInfo ? resolveGitPath(gitDir, (await readText(fs, commonPointer, signal)).trim()) : gitDir;
  if (!((await readIo(() => fs.stat(commonDir), signal)).type & DIRECTORY)) throw new Error('commondir does not point to a directory');
  const config = parseGitConfig(await readText(fs, join(commonDir, 'config'), signal));
  if (config.worktreeConfig) {
    const worktreeUri = join(gitDir, 'config.worktree');
    if (await optionalStat(fs, worktreeUri, signal)) {
      const worktree = parseGitConfig(await readText(fs, worktreeUri, signal));
      config.remotes.push(...worktree.remotes);
      config.incomplete ||= worktree.incomplete;
    }
  }
  return config;
}

/** Discover candidates from repository metadata only; no Git, SSH or shell is executed. */
export async function discoverRepositories(roots: URI[], fs: DiscoveryFileSystem, signal?: AbortSignal, locale: 'en' | 'zh-cn' = 'zh-cn'): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { candidates: [], warnings: [] };
  const messages = WARNINGS[locale];
  const found = new Set<string>();
  const candidateIndex = new Map<string, RepositoryCandidate>();
  for (const start of roots) {
    abort(signal);
    let root: URI | null;
    try { root = await findRoot(start, fs, signal); }
    catch (error) {
      abort(signal);
      result.warnings.push(messages.inaccessible);
      continue;
    }
    if (!root || found.has(root.toString())) continue;
    found.add(root.toString());
    let config: GitConfiguration;
    try { config = await readConfiguration(root, fs, signal); }
    catch (error) {
      abort(signal);
      result.warnings.push(messages.invalid);
      continue;
    }
    if (config.incomplete) result.warnings.push(messages.partial);
    for (const remote of config.remotes) {
      const repository = parseRemote(remote.url);
      if (!repository) {
        result.warnings.push(messages.remote);
        continue;
      }
      const source: RepositorySource = { root, remote: remote.name, source: `${remote.name} · ${root.path}` };
      const key = repository.toLowerCase();
      const existing = candidateIndex.get(key);
      if (existing) {
        if (!existing.sources.some(item => item.root.toString() === root.toString() && item.remote === remote.name)) existing.sources.push(source);
      } else {
        const candidate: RepositoryCandidate = { repository, ...source, sources: [source] };
        candidateIndex.set(key, candidate);
        result.candidates.push(candidate);
      }
    }
  }
  result.warnings = [...new Set(result.warnings)];
  return result;
}
