import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.ELV_DESKTOP_OUT_DIR ?? join(rootDir, 'dist');
const development = process.env.APP_VARIANT === 'development';
const defaultSyncServerUrl = (process.env.ELV_SYNC_SERVER_URL ?? '').trim();

await build({
  entryPoints: [join(rootDir, 'src', 'main', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  define: {
    __ELV_DEV_SEED__: JSON.stringify(development),
    __ELV_SYNC_SERVER_URL__: JSON.stringify(defaultSyncServerUrl),
  },
  outfile: join(outDir, 'main', 'main.js'),
  logLevel: 'warning',
});

await build({
  entryPoints: [join(rootDir, 'src', 'preload', 'preload.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: join(outDir, 'preload', 'preload.js'),
  logLevel: 'warning',
});

await build({
  entryPoints: [join(rootDir, 'src', 'utility', 'catalog-worker.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'better-sqlite3'],
  outfile: join(outDir, 'utility', 'catalog-worker.js'),
  logLevel: 'warning',
});
