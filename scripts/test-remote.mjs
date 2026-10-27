import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { URI } from 'vscode-uri';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the opt-in Remote SSH test.`);
  return value;
}
const folder = URI.parse(required('TILELANG_CI_REMOTE_URI'));
if (folder.scheme !== 'vscode-remote' || !folder.authority.startsWith('ssh-remote+')
  || folder.authority.length <= 'ssh-remote+'.length || !folder.path.startsWith('/') || folder.query || folder.fragment) {
  throw new Error('TILELANG_CI_REMOTE_URI must be an absolute Remote SSH folder URI without query or fragment.');
}
const executable = await realpath(resolve(required('VSCODE_EXECUTABLE_PATH')));
if (!(await stat(executable)).isFile()) throw new Error('VSCODE_EXECUTABLE_PATH must point to the VS Code executable.');
const extensions = await realpath(resolve(required('TILELANG_CI_EXTENSIONS_DIR')));
if (!(await stat(extensions)).isDirectory()) throw new Error('TILELANG_CI_EXTENSIONS_DIR must be an isolated extensions directory.');
const equivalentPath = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
for (const name of ['.vscode', '.vscode-insiders', '.vscode-oss', '.vscode-remote']) {
  const installed = join(homedir(), name, 'extensions');
  let installedReal = installed;
  try { installedReal = await realpath(installed); } catch { /* The directory need not exist. */ }
  if (equivalentPath(extensions) === equivalentPath(installedReal)) {
    throw new Error('Use an isolated copy of Remote SSH, not your normal VS Code extensions directory.');
  }
}
const allowed = new Set(['ms-vscode-remote.remote-ssh', 'ms-vscode-remote.remote-ssh-edit', 'ms-vscode.remote-explorer']);
const installed = new Set();
for (const item of await readdir(extensions, { withFileTypes: true })) {
  if (!item.isDirectory() && !item.isSymbolicLink()) continue;
  let manifest;
  try { manifest = JSON.parse(await readFile(join(extensions, item.name, 'package.json'), 'utf8')); }
  catch { throw new Error('The isolated extensions directory contains an unreadable extension manifest.'); }
  const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
  if (!allowed.has(id)) throw new Error('The isolated extensions directory must contain only Remote SSH and its Remote Explorer/SSH Edit companions.');
  installed.add(id);
}
if (!installed.has('ms-vscode-remote.remote-ssh')) throw new Error('Copy the Remote SSH extension into TILELANG_CI_EXTENSIONS_DIR before running this test.');

const profile = join(root, 'artifacts', 'remote-profile');
await mkdir(join(profile, 'User'), { recursive: true });
// This profile belongs only to this test. Do not alter existing user settings.
try {
  await writeFile(join(profile, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none',
    'window.restoreWindows': 'none',
    'tilelangCI.autoRefresh': false,
    'security.workspace.trust.enabled': false,
  }, null, 2), { flag: 'wx' });
} catch (error) {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
}

process.chdir(root);
await import('./build.mjs');
const testBundle = join(root, 'artifacts', 'remote-tests', 'remote.integration.cjs');
await build({ entryPoints: ['test/remote.integration.ts'], outfile: testBundle, bundle: true,
  platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] });
console.log('Starting opt-in Remote SSH metadata integration test with an isolated profile.');
await runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: root,
  extensionTestsPath: testBundle,
  extensionTestsEnv: { TILELANG_CI_REMOTE_URI: folder.toString() },
  launchArgs: ['--new-window', '--skip-welcome', '--skip-release-notes', '--disable-gpu',
    '--user-data-dir', profile, '--extensions-dir', extensions, '--folder-uri', folder.toString()],
});
