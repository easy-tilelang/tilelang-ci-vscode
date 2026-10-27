import { build, context } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
const configs = [
 { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true },
 { entryPoints: ['src/webview/app.tsx'], outfile: 'dist/webview.js', bundle: true, platform: 'browser', format: 'iife', target: 'es2022', minify: true, sourcemap: true, define: { 'process.env.NODE_ENV': '"production"' } }
];
if (process.argv.includes('--watch')) {
 const contexts = await Promise.all(configs.map(c => context(c)));
 await Promise.all(contexts.map(c => c.watch()));
 console.log('Watching TileLang CI sources');
} else await Promise.all(configs.map(c => build(c)));
