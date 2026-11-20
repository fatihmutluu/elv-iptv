import { createFakePlayerEngine } from '@elv/playback/testing';
import { describe, expect, it } from 'vitest';
import { createCorpusSweep } from './corpus-runner';

describe('createCorpusSweep', () => {
  it('fails track items when track-selection capabilities are disabled and handles idempotent dispose', async () => {
    const engine = createFakePlayerEngine({
      capabilities: { audioTrackSelection: false, subtitleTrackSelection: false },
      now: () => performance.now(),
      schedule: (fn, ms) => setTimeout(fn, Math.min(ms, 1)),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    const baseLoad = engine.load.bind(engine);
    engine.load = (cmd) => {
      baseLoad(cmd);
      setTimeout(() => {
        engine.emit({ attempt: cmd.attempt, type: 'firstFrame', atMs: performance.now() });
        engine.emit({ attempt: cmd.attempt, type: 'state', state: 'playing' });
        engine.emit({
          attempt: cmd.attempt,
          type: 'clock',
          anchor: { positionMs: 100, atMs: performance.now(), rate: 1 },
        });
      }, 1);
    };

    const sweep = createCorpusSweep({
      engine,
      params: { host: '127.0.0.1:7878', account: 'demo', burst: 0 },
      now: () => performance.now(),
      later: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      holdMs: 2,
      itemTimeoutMs: 100,
    });

    const report = await sweep.start();
    expect(report).toBeDefined();
    const reasons = Object.fromEntries((report?.failed ?? []).map((f) => [f.id, f.reason]));
    expect(reasons['live-1010']).toBe('audio track selection unsupported');
    expect(reasons['live-1010-hls']).toBe('subtitle track selection unsupported');

    sweep.dispose();
    sweep.dispose();
    expect(await sweep.start()).toBeUndefined();
  });
});
