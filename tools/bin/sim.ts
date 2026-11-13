import { parseArgs } from 'node:util';
import { startSim } from '../src/sim/server.ts';

const USAGE =
  'usage: pnpm sim [--port 7878] [--host 127.0.0.1|0.0.0.0] [--seed 1] [--clock <ISO time>] [--log <file>] [--prepare]';

function fail(message: string): never {
  process.stderr.write(`${message.startsWith('sim:') ? '' : 'sim: '}${message}\n${USAGE}\n`);
  process.exit(2);
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
    process.stderr.write('sim: --prepare needs media support\n');
    process.exit(2);
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
