import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const tests = (await readdir('test')).filter(n => n.endsWith('.test.ts') && !n.startsWith('extension')).map(n => 'test/' + n);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], { stdio: 'inherit' });
process.exit(result.status ?? 1);
