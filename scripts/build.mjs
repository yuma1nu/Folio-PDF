import { build } from 'vite';
import { build as bundle } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import './notices.mjs';
await build();
await mkdir('dist/pdf-assets', { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) await cp(`node_modules/pdfjs-dist/${dir}`, `dist/pdf-assets/${dir}`, { recursive: true });
await bundle({ entryPoints: ['electron/main.ts', 'electron/preload.ts', 'electron/pdf-worker.ts'], outdir: 'dist-electron', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true });
