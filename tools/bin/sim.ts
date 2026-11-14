import { parseArgs } from 'node:util';
import { ensureRecipe, findFfmpeg, missingEncoders } from '../src/sim/media.ts';
import { ALL_RECIPES, RECIPES } from '../src/sim/recipes.ts';
import { defaultCacheDir, startSim } from '../src/sim/server.ts';

const USAGE =
  'usage: pnpm sim [--port 7878] [--host 127.0.0.1|0.0.0.0] [--seed 1] [--clock <ISO time>] [--log <file>] [--prepare]';

function fail(message: string): never {
  process.stderr.write(`${message.startsWith('sim:') ? '' : 'sim: '}${message}\n${USAGE}\n`);
  process.exit(2);
}

async function prepare(): Promise<void> {
  const ffmpeg = findFfmpeg();
  if (ffmpeg === null) fail('FFmpeg not found: set FFMPEG_PATH or install FFmpeg');
  const cacheDir = defaultCacheDir();
  const started = Date.now();
  let prepared = 0;
  const skipped: string[] = [];
  for (const recipe of ALL_RECIPES) {
    if (missingEncoders(ffmpeg, recipe).length > 0) {
      skipped.push(`skipped ${recipe} (no ${RECIPES[recipe].encoders.join(' ')})`);
      continue;
    }
    await ensureRecipe(recipe, { ffmpeg, cacheDir, seconds: 600 });
    prepared++;
  }
  const sec = Math.round((Date.now() - started) / 1000);
  const tail = skipped.length > 0 ? `, ${skipped.join(', ')}` : '';
  process.stdout.write(`sim: prepared ${prepared} recipes in ${cacheDir} (${sec}s)${tail}\n`);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      seed: { type: 'string' },
      clock: { type: 'string' },
      log: { type: 'string' },
      prepare: { type: 'boolean' },
    },
    strict: true,
  });
  if (values.prepare) {
    prepare().then(
      () => process.exit(0),
      (error: Error) => fail(error.message),
    );
    return;
  }
  const port = values.port === undefined ? 7878 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) fail(`invalid --port "${values.port}"`);
  const seed = values.seed === undefined ? 1 : Number(values.seed);
  if (!Number.isInteger(seed)) fail(`invalid --seed "${values.seed}"`);
  const clock = values.clock === undefined ? undefined : new Date(values.clock);
  if (clock && Number.isNaN(clock.getTime())) fail(`invalid --clock "${values.clock}"`);
  const host = values.host ?? '127.0.0.1';
  startSim({
    port,
    host,
    seed,
    ...(clock ? { clock } : {}),
    ...(values.log ? { logFile: values.log } : {}),
  }).then(
    (sim) => {
      process.stdout.write(`sim: ${sim.url} (Android emulator: http://10.0.2.2:${sim.port})\n`);
      const stop = (): void => {
        sim.close().then(() => process.exit(0));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    },
    (error: Error) => fail(error.message),
  );
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
