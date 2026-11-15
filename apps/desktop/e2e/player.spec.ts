import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { mpvRuntimePaths } from '../src/main/player/runtime-path.ts';
import { SIM_URL, simulatorAnswers } from '../src/main/player/testing/sim-streams.ts';

const DESKTOP_ROOT = join(__dirname, '..');

test('gate route with one live channel reaches firstFrame', async () => {
  const runtime = mpvRuntimePaths({
    isPackaged: false,
    resourcesPath: '',
    appPath: DESKTOP_ROOT,
    platform: process.platform,
    arch: process.arch,
  });
  if (!runtime) {
    test.skip(true, 'mpv runtime is not installed for this platform');
    return;
  }
  if (!(await simulatorAnswers())) {
    test.skip(true, `Stream simulator is not reachable at ${SIM_URL}`);
    return;
  }

  const query = `elv-gate=player&base=${SIM_URL}&account=demo&channels=1001&zaps=1&rate=0.5`;
  const app = await electron.launch({
    args: [DESKTOP_ROOT, `--elv-gate=${query}`],
  });

  try {
    const proc = app.process();
    const gateLine = await new Promise<string>((resolvePromise, rejectPromise) => {
      let buffer = '';
      const timer = setTimeout(() => {
        rejectPromise(new Error(`Timed out waiting for ELV_GATE_PLAYER line.\n${buffer}`));
      }, 30_000);
      proc.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const found = buffer.split(/\r?\n/).find((line) => line.startsWith('ELV_GATE_PLAYER {'));
        if (found) {
          clearTimeout(timer);
          resolvePromise(found);
        }
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        const found = buffer.split(/\r?\n/).find((line) => line.startsWith('ELV_GATE_PLAYER {'));
        if (found) resolvePromise(found);
        else
          rejectPromise(
            new Error(
              `Electron exited (${String(code)}) before printing ELV_GATE_PLAYER.\n${buffer}`,
            ),
          );
      });
    });

    const payload = JSON.parse(gateLine.slice('ELV_GATE_PLAYER '.length)) as {
      ttffColdMs: number | null;
      failures: number;
      mpvSpawns: number;
    };
    expect(typeof payload.ttffColdMs).toBe('number');
    expect(payload.ttffColdMs as number).toBeGreaterThan(0);
    expect(payload.failures).toBe(0);
    expect(payload.mpvSpawns).toBe(1);
  } finally {
    await app.close().catch(() => {});
  }
});
