import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';
import { resolve } from 'node:path';
await build({ entryPoints: ['test/extension.test.ts'], outfile: 'dist/test/extension.test.cjs', bundle: true,
  platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] });
await runTests({ extensionDevelopmentPath: process.cwd(), extensionTestsPath: resolve('dist/test/extension.test.cjs'),
  ...(process.env.VSCODE_EXECUTABLE_PATH ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH } : { version: process.env.VSCODE_TEST_VERSION || '1.95.3' }),
  launchArgs: ['--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu', '--disable-extensions'] });
