import assert from 'node:assert/strict';
import test from 'node:test';
import { parseViewMessage, safeGitHubUrl, validFilters } from '../src/host/protocol.js';
import { DEFAULT_FILTERS } from '../src/shared/model.js';

test('webview bridge only accepts known intents and bounded filters', () => {
  assert.deepEqual(parseViewMessage({ type: 'refresh', token: 'do-not-forward' }), { type: 'refresh' });
  for (const value of [null, 'refresh', {}, { type: 'runShell' }, { type: 'setFilters', filters: { ...DEFAULT_FILTERS, pr: -1 } }]) {
    assert.equal(parseViewMessage(value), null);
  }
  assert.equal(validFilters({ ...DEFAULT_FILTERS, search: 'a'.repeat(501) }), false);
  assert.equal(validFilters({ ...DEFAULT_FILTERS, resource: 'nvidia', pr: 12 }), true);
});
test('external navigation cannot run commands or send data to a remote supplied host', () => {
  assert.equal(safeGitHubUrl('https://github.com/owner/repo/pull/9'), true);
  for (const url of ['javascript:alert(1)', 'command:workbench.action.closeWindow', 'https://github.com.evil.test/a',
    'https://token@github.com/owner/repo', 'http://github.com/a', 'https://github.com:8443/a', 'file:///secret']) {
    assert.equal(safeGitHubUrl(url), false);
    assert.equal(parseViewMessage({ type: 'openExternal', url }), null);
  }
});
