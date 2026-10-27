import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { DashboardState } from '../src/shared/model.js';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<{ getState(): DashboardState }>('easy-tilelang.tilelang-ci-vscode');
  assert.ok(extension, 'TileLang CI must be installed in the test host');
  const api = await extension.activate();
  assert.equal(extension.extensionKind, vscode.ExtensionKind.UI);
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['open', 'selectRepository', 'refresh', 'signIn', 'switchAccount', 'showLogs', 'demo', 'enablePrivate']) {
    assert.ok(commands.includes(`tilelangCI.${command}`), command);
  }
  await vscode.commands.executeCommand('tilelangCI.demo');
  assert.equal(api.getState().snapshot?.demo, true);
  assert.ok(api.getState().snapshot!.queues.length > 1);
  await vscode.commands.executeCommand('tilelangCI.openFiltered', { mine: true, pr: 7 });
  assert.equal(api.getState().filters.mine, true);
  assert.equal(api.getState().filters.pr, 7);
  const before = api.getState().snapshot!.fetchedAt;
  await vscode.commands.executeCommand('tilelangCI.refresh');
  assert.equal(api.getState().snapshot!.fetchedAt, before, 'Offline demo must never call GitHub');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('TileLang CI Extension Host smoke checks passed.');
}
