import assert from 'node:assert/strict';
import test from 'node:test';
import { URI } from 'vscode-uri';
import { discoverRepositories, parseGitConfig, parseRemote, resolveGitPath, type DiscoveryFileSystem } from '../src/discovery/index.js';

class MemoryFs implements DiscoveryFileSystem {
  files = new Map<string, string>();
  directories = new Set<string>();
  reads: string[] = [];
  private key(uri: URI) { return uri.toString(); }
  file(uri: URI, text: string) { this.files.set(this.key(uri), text); return this; }
  directory(uri: URI) { this.directories.add(this.key(uri)); return this; }
  async stat(uri: URI) {
    const key = this.key(uri);
    if (this.directories.has(key)) return { type: 2 };
    const text = this.files.get(key);
    if (text !== undefined) return { type: 1, size: new TextEncoder().encode(text).length };
    throw Object.assign(new Error('Missing entry'), { code: 'FileNotFound' });
  }
  async readFile(uri: URI) {
    this.reads.push(this.key(uri));
    const text = this.files.get(this.key(uri));
    if (text === undefined) throw Object.assign(new Error('Missing entry'), { code: 'ENOENT' });
    return new TextEncoder().encode(text);
  }
}
const local = (path: string) => URI.file(path);
const remote = (path: string) => URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+build-host', path });
const config = (url: string, name = 'origin') => `[remote "${name}"]\nurl = ${url}\n`;

test('remote URLs are canonicalized without exposing credentials', () => {
  for (const url of ['https://github.com/easy-tilelang/tilelang.git', 'git@github.com:easy-tilelang/tilelang.git',
    'ssh://git@github.com/easy-tilelang/tilelang', 'ssh://git@github.com:22/easy-tilelang/tilelang.git',
    'ssh://git@ssh.github.com:443/easy-tilelang/tilelang.git', 'https://secret:token@github.com/easy-tilelang/tilelang']) {
    assert.equal(parseRemote(url), 'easy-tilelang/tilelang');
  }
  for (const url of ['https://github.com.evil.test/a/b', 'git@github-work:a/b', 'http://github.com/a/b',
    'https://github.com/a/b?token=secret', 'https://github.com/a/b/c', 'https://github.com/a/%2f',
    'ssh://git@ssh.github.com/a/b', 'ssh://git@github.com:443/a/b', 'file:///tmp/repo']) assert.equal(parseRemote(url), null);
});

test('Git config handles comments, quoted sections, escape and continuation syntax', () => {
  const parsed = parseGitConfig('\uFEFF[ReMoTe "Origin"]\r\n UrL = "https://github.com/easy-tilelang/"\\\r\n"tilelang.git" # comment\r\nurl = git@github.com:owner/another.git ; comment\n[remote "quote\\\"name"]\nurl = "https://github.com/a/b"\n[extensions]\nworktreeConfig = yes\n[includeIf "gitdir:~/projects/"]\npath = other\n');
  assert.deepEqual(parsed.remotes, [
    { name: 'Origin', url: 'https://github.com/easy-tilelang/tilelang.git' },
    { name: 'Origin', url: 'git@github.com:owner/another.git' },
    { name: 'quote"name', url: 'https://github.com/a/b' },
  ]);
  assert.equal(parsed.worktreeConfig, true);
  assert.equal(parsed.incomplete, true);
  assert.equal(parseGitConfig('[remote.origin]\nurl=https://github.com/a/b\n').remotes[0]?.name, 'origin');
  for (const invalid of ['[remote "broken]\nurl=x', '[remote "x"]\nurl="broken\n', '[x]\nkey=bad\\q', '[extensions]\nworktreeConfig=maybe']) {
    assert.throws(() => parseGitConfig(invalid));
  }
});

test('ordinary repository discovery walks up and preserves origin and upstream', async () => {
  const fs = new MemoryFs().directory(local('/repo/.git')).file(local('/repo/.git/config'), config('git@github.com:alice/tilelang.git') + config('https://github.com/tile-ai/tilelang.git', 'upstream'));
  const result = await discoverRepositories([local('/repo/src/kernels'), local('/repo')], fs);
  assert.deepEqual(result.candidates.map(item => item.repository), ['alice/tilelang', 'tile-ai/tilelang']);
  assert.equal(result.candidates[0]?.root.path, '/repo');
  assert.deepEqual(result.warnings, []);
  assert.equal(fs.reads.filter(path => path.endsWith('/config')).length, 1);
});

test('remote worktree follows gitdir and commondir while retaining authority', async () => {
  const fs = new MemoryFs()
    .file(remote('/home/user/工作区/.git'), 'gitdir: ../main/.git/worktrees/work\r\n')
    .directory(remote('/home/user/main/.git/worktrees/work'))
    .directory(remote('/home/user/main/.git'))
    .file(remote('/home/user/main/.git/worktrees/work/commondir'), '../..\n')
    .file(remote('/home/user/main/.git/config'), '[extensions]\nworktreeConfig=true\n' + config('https://github.com/owner/base'))
    .file(remote('/home/user/main/.git/worktrees/work/config.worktree'), config('git@github.com:owner/worktree.git', 'upstream'));
  const result = await discoverRepositories([remote('/home/user/工作区')], fs);
  assert.deepEqual(result.candidates.map(item => item.repository), ['owner/base', 'owner/worktree']);
  assert.ok(fs.reads.every(uri => uri.startsWith('vscode-remote://ssh-remote%2Bbuild-host/')));
  assert.equal(result.candidates[0]?.root.authority, 'ssh-remote+build-host');
});

test('worktree configuration is ignored unless explicitly enabled', async () => {
  const fs = new MemoryFs().directory(local('/repo/.git'))
    .file(local('/repo/.git/config'), config('https://github.com/a/base'))
    .file(local('/repo/.git/config.worktree'), config('https://github.com/a/ignored'));
  assert.deepEqual((await discoverRepositories([local('/repo')], fs)).candidates.map(item => item.repository), ['a/base']);
  assert.ok(!fs.reads.some(path => path.endsWith('config.worktree')));
});

test('absolute gitfile handles submodules without selecting the superproject', async () => {
  const fs = new MemoryFs().file(remote('/repo/sub/.git'), 'gitdir: /repo/.git/modules/sub\n')
    .directory(remote('/repo/.git/modules/sub'))
    .file(remote('/repo/.git/modules/sub/config'), config('https://github.com/a/sub'))
    .directory(remote('/repo/.git')).file(remote('/repo/.git/config'), config('https://github.com/a/super'));
  const result = await discoverRepositories([remote('/repo/sub/src')], fs);
  assert.equal(result.candidates[0]?.repository, 'a/sub');
  assert.equal(result.candidates.length, 1);
});

test('same repository is deduplicated but retains all workspace and remote sources', async () => {
  const fs = new MemoryFs().directory(local('/one/.git')).file(local('/one/.git/config'), config('https://github.com/Owner/Repo') + config('git@github.com:owner/repo.git', 'upstream'))
    .directory(local('/two/.git')).file(local('/two/.git/config'), config('ssh://git@github.com/owner/repo'));
  const result = await discoverRepositories([local('/one'), local('/two')], fs);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.sources.length, 3);
});

test('unsupported includes, URL rewrites and aliases expose only safe diagnostics', async () => {
  const secret = 'credential-that-must-not-leak';
  const fs = new MemoryFs().directory(local('/repo/.git')).file(local('/repo/.git/config'),
    config(`https://user:${secret}@github.com/a/b`) + config(`git@github-work:a/${secret}`, 'alias')
      + '[include]\npath=/secret/path\n[url "git@github-work:"]\ninsteadOf=gh:\n');
  const result = await discoverRepositories([local('/repo')], fs);
  assert.equal(result.candidates[0]?.repository, 'a/b');
  assert.equal(result.warnings.length, 2);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!fs.reads.some(path => path.includes('/secret/path')));
});

test('broken or looping nearest gitfile does not fall back to a parent repository', async () => {
  for (const pointer of ['gitdir: .git', 'gitdir: https://attacker.test/path', 'gitdir: .git\ngitdir: /elsewhere']) {
    const fs = new MemoryFs().file(local('/repo/sub/.git'), pointer).directory(local('/repo/.git')).file(local('/repo/.git/config'), config('https://github.com/a/super'));
    const result = await discoverRepositories([local('/repo/sub')], fs);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.warnings.length, 1);
  }
});

test('Windows metadata paths preserve remote URI and reject ambiguous paths', () => {
  const base = remote('/C:/work/项目');
  assert.equal(resolveGitPath(base, 'D:\\repos\\main\\.git').toString(), remote('/D:/repos/main/.git').toString());
  assert.equal(resolveGitPath(base, '..\\main\\.git').path, '/C:/work/main/.git');
  for (const invalid of ['C:relative', '\\\\server\\share', '//server/share', 'file:///tmp', 'vscode-remote://other/root']) assert.throws(() => resolveGitPath(base, invalid));
  assert.equal(resolveGitPath(remote('/home/x'), 'a\\b').path, '/home/x/a\\b');
});

test('Windows remote gitfile with absolute drive path discovers the referenced repository', async () => {
  const fs = new MemoryFs().file(remote('/C:/work/repo/.git'), 'gitdir: D:\\metadata\\repo.git\r\n')
    .directory(remote('/D:/metadata/repo.git')).file(remote('/D:/metadata/repo.git/config'), config('https://github.com/a/windows'));
  const result = await discoverRepositories([remote('/C:/work/repo')], fs);
  assert.equal(result.candidates[0]?.repository, 'a/windows');
  assert.ok(fs.reads.every(uri => uri.startsWith('vscode-remote:')));
});

test('oversized or unreadable metadata returns manual selection diagnostics', async () => {
  const fs = new MemoryFs().directory(local('/repo/.git')).file(local('/repo/.git/config'), 'x'.repeat(1024 * 1024 + 1));
  const result = await discoverRepositories([local('/repo')], fs);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.equal(fs.reads.length, 0);
  const denied: DiscoveryFileSystem = { stat: async () => { throw Object.assign(new Error('Sensitive path'), { code: 'EACCES' }); }, readFile: async () => new Uint8Array() };
  const inaccessible = await discoverRepositories([local('/repo')], denied);
  assert.equal(inaccessible.warnings.length, 1);
  assert.ok(!JSON.stringify(inaccessible).includes('Sensitive path'));
});

test('missing metadata remains usable for manual entry and cancellation propagates', async () => {
  assert.deepEqual(await discoverRepositories([local('/empty')], new MemoryFs()), { candidates: [], warnings: [] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discoverRepositories([local('/repo')], new MemoryFs(), controller.signal), { name: 'AbortError' });
});

test('cancellation interrupts an outstanding filesystem read', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const fs: DiscoveryFileSystem = {
    stat: async () => { started(); return new Promise(() => {}); },
    readFile: async () => new Uint8Array(),
  };
  const discovery = discoverRepositories([remote('/repo')], fs, controller.signal);
  await pending;
  controller.abort();
  await assert.rejects(discovery, { name: 'AbortError' });
});

test('discovery diagnostics support the English dashboard locale', async () => {
  const fs = new MemoryFs().directory(local('/repo/.git')).file(local('/repo/.git/config'), config('git@github-work:a/repo'));
  const result = await discoverRepositories([local('/repo')], fs, undefined, 'en');
  assert.match(result.warnings[0]!, /SSH aliases/);
});
