import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { URI } from 'vscode-uri';
import { discoverRepositories } from '../src/discovery/index.js';

function sameFolder(left: URI, right: URI): boolean {
  return left.scheme === right.scheme && left.authority === right.authority
    && left.path.replace(/\/+$/, '') === right.path.replace(/\/+$/, '');
}
async function withDeadline<T>(task: PromiseLike<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(task), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Opt-in only: runs inside the local UI Extension Host attached to a real SSH workspace. */
export async function run(): Promise<void> {
  const expectedValue = process.env.TILELANG_CI_REMOTE_URI;
  assert.ok(expectedValue, 'TILELANG_CI_REMOTE_URI must be forwarded by the opt-in test runner');
  const expected = URI.parse(expectedValue);
  assert.equal(expected.scheme, 'vscode-remote');
  assert.equal(vscode.env.remoteName, 'ssh-remote', 'The test must be attached to a Remote SSH workspace');
  const folders = vscode.workspace.workspaceFolders ?? [];
  const selected = folders.find(folder => sameFolder(URI.parse(folder.uri.toString()), expected));
  assert.ok(selected, 'The configured Remote SSH folder must be present in workspaceFolders');
  assert.equal(selected.uri.scheme, 'vscode-remote');
  // Stat establishes that the remote filesystem provider is connected before discovery.
  const folderInfo = await withDeadline(vscode.workspace.fs.stat(selected.uri), 120_000,
    'The Remote SSH filesystem did not become available within two minutes');
  assert.ok(folderInfo.type & vscode.FileType.Directory, 'The remote workspace must be a readable directory');

  const extension = vscode.extensions.getExtension('easy-tilelang.tilelang-ci-vscode');
  assert.ok(extension, 'TileLang CI must be installed in the test host');
  assert.equal(extension.extensionKind, vscode.ExtensionKind.UI, 'CI credentials and API requests must stay in the local UI host');
  await withDeadline(extension.activate(), 30_000, 'TileLang CI activation timed out');
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('tilelangCI.open'));
  assert.ok(commands.includes('tilelangCI.selectRepository'));

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 120_000);
  try {
    const result = await discoverRepositories([URI.parse(selected.uri.toString())], {
      stat: async uri => vscode.workspace.fs.stat(vscode.Uri.parse(uri.toString())),
      readFile: async uri => vscode.workspace.fs.readFile(vscode.Uri.parse(uri.toString())),
    }, abort.signal, 'en');
    assert.ok(result.candidates.length > 0, 'The remote Git metadata must expose at least one direct GitHub repository candidate');
    const repositories = result.candidates.map(candidate => candidate.repository);
    for (const candidate of result.candidates) {
      assert.equal(candidate.root.scheme, selected.uri.scheme);
      assert.equal(candidate.root.authority, selected.uri.authority);
      assert.match(candidate.repository, /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/);
    }
    // Canonical owner/repo only: do not print SSH aliases, hostnames, paths or raw remotes.
    console.log(`Remote SSH GitHub candidates (${repositories.length}): ${repositories.join(', ')}`);
    console.log(`Remote SSH metadata discovery warnings: ${result.warnings.length}`);
    console.log('TileLang CI local UI host and real Remote SSH metadata checks passed.');
  } finally { clearTimeout(timeout); }
}
