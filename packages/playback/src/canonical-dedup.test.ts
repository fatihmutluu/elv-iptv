import { elvError, err, ok } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineError, StreamRequest } from './engine';
import {
  error,
  failed,
  live,
  play,
  playing,
  type Rig,
  recovering,
  req,
  resolved,
  rig,
  status,
  tick,
} from './recovery-test-helpers';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

function emitError(r: Rig, e: EngineError): void {
  r.engine.emit({ attempt: r.service.getState().attempt, type: 'error', error: e });
}

async function climbToRung4(r: Rig, e: EngineError = { code: 'network' }): Promise<void> {
  // Rung 1 (gap 0), Rung 2 (gap 1000), Rung 3 (gap 2000), Rung 4 (gap 4000)
  for (const gap of [0, 1000, 2000, 4000]) {
    emitError(r, e);
    await tick(gap);
  }
}

describe('#287: Rung-4 multi-alternate iteration & canonical post-redirect deduplication', () => {
  it('iterates through all TuneRequest.alternates across Rung-4 escalations instead of stopping after alternates[0]', async () => {
    const r = rig({
      'http://primary.example/live/1.ts': [],
      'http://alt1.example/live/1.ts': [],
      'http://alt2.example/live/1.ts': [],
      'http://alt3.example/live/1.ts': [],
    });
    await playing(
      r,
      live('http://primary.example/live/1.ts', {
        alternates: [
          resolved('http://alt1.example/live/1.ts'),
          resolved('http://alt2.example/live/1.ts'),
          resolved('http://alt3.example/live/1.ts'),
        ],
      }),
    );

    await climbToRung4(r);
    expect(r.loads.at(-1)?.url).toBe('http://alt1.example/live/1.ts');

    // alt1 fails -> advances to alt2 on Rung 4
    error(r, 'network');
    expect(status(r)).toEqual(recovering(4, 4000));
    await tick(4000);
    expect(r.loads.at(-1)?.url).toBe('http://alt2.example/live/1.ts');

    // alt2 fails -> advances to alt3 on Rung 4
    error(r, 'network');
    expect(status(r)).toEqual(recovering(4, 4000));
    await tick(4000);
    expect(r.loads.at(-1)?.url).toBe('http://alt3.example/live/1.ts');

    // alt3 succeeds
    play(r);
    expect(status(r)).toEqual({ kind: 'playing' });
  });

  it('traverses TuneRequest.alternates followed by inline primaryStream.alternates captured before Rung 4', async () => {
    const r = rig({
      'http://p.example/1.ts': [],
      'http://req-alt.example/1.ts': [],
      'http://inline-1.example/1.ts': [],
      'http://inline-2.example/1.ts': [],
    });
    const primaryStream: StreamRequest = {
      url: 'http://p.example/1.ts',
      headers: {},
      alternates: [req('http://inline-1.example/1.ts'), req('http://inline-2.example/1.ts')],
    };
    await playing(
      r,
      live('http://p.example/1.ts', {
        resolve: () => Promise.resolve(ok(primaryStream)),
        alternates: [resolved('http://req-alt.example/1.ts')],
      }),
    );

    await climbToRung4(r);
    expect(r.loads.at(-1)?.url).toBe('http://req-alt.example/1.ts');

    error(r, 'network');
    await tick(4000);
    expect(r.loads.at(-1)?.url).toBe('http://inline-1.example/1.ts');

    error(r, 'network');
    await tick(4000);
    expect(r.loads.at(-1)?.url).toBe('http://inline-2.example/1.ts');

    error(r, 'network');
    expect(status(r)).toEqual(failed('network'));
  });

  it('skips alternates whose canonical url matches a failed stream (rotated tokens, default ports, Xtream credentials)', async () => {
    const liveStream = (host: string, u: string, p: string, query: string) =>
      `http://${host}/live/${u}/${p}/42.ts?${query}`;
    const primaryUrl = liveStream('CDN.Example:80', 'u1', 'p1', 'token=abc&sig=1');
    const duplicateAltUrl = liveStream('cdn.example', 'u2', 'p2', 'token=xyz');
    const healthyBackupUrl = 'http://backup.example/live/42.ts';
    const r = rig({
      [primaryUrl]: [],
      [duplicateAltUrl]: [],
      [healthyBackupUrl]: [],
    });
    await playing(
      r,
      live(primaryUrl, {
        alternates: [resolved(duplicateAltUrl), resolved(healthyBackupUrl)],
      }),
    );

    await climbToRung4(r);
    expect(r.loads.map((l) => l.url)).not.toContain(duplicateAltUrl);
    expect(r.loads.at(-1)?.url).toBe(healthyBackupUrl);
  });

  it('deduplicates alternates against post-redirect error.finalUrl and stream.finalUrl', async () => {
    const r = rig({
      'http://front1.example/play/ch1': [],
      'http://front2.example/play/ch1': [],
      'http://front3.example/play/ch1': [],
      'http://healthy.example/play/ch1': [],
    });
    const primary: StreamRequest = {
      url: 'http://front1.example/play/ch1',
      finalUrl: 'https://origin-a.example:443/stream/1.m3u8?token=t1',
      headers: {},
    };
    const altDupByStreamFinal = (): Promise<ReturnType<typeof ok<StreamRequest>>> =>
      Promise.resolve(
        ok({
          url: 'http://front2.example/play/ch1',
          finalUrl: 'https://ORIGIN-A.EXAMPLE/stream/1.m3u8?token=t2',
          headers: {},
        }),
      );
    const altDupByErrorFinal = (): Promise<ReturnType<typeof ok<StreamRequest>>> =>
      Promise.resolve(
        ok({
          url: 'http://front3.example/play/ch1',
          finalUrl: 'http://origin-b.example/stream/9.ts?expires=999',
          headers: {},
        }),
      );

    await playing(
      r,
      live('http://front1.example/play/ch1', {
        resolve: () => Promise.resolve(ok(primary)),
        alternates: [
          altDupByStreamFinal,
          altDupByErrorFinal,
          resolved('http://healthy.example/play/ch1'),
        ],
      }),
    );

    await climbToRung4(r, {
      code: 'network',
      finalUrl: 'http://origin-b.example:80/stream/9.ts?expires=111',
    });

    const loadedUrls = r.loads.map((l) => l.url);
    expect(loadedUrls).not.toContain('http://front2.example/play/ch1');
    expect(loadedUrls).not.toContain('http://front3.example/play/ch1');
    expect(loadedUrls.at(-1)).toBe('http://healthy.example/play/ch1');
  });

  it('skips failed and rejected alternate resolvers and advances cleanly to the next valid alternate', async () => {
    const r = rig({
      'http://p.example/1.ts': [],
      'http://good.example/1.ts': [],
    });
    await playing(
      r,
      live('http://p.example/1.ts', {
        alternates: [
          () => Promise.resolve(err(elvError('network', 'resolve-failed'))),
          () => Promise.reject(new Error('boom')),
          resolved('http://good.example/1.ts'),
        ],
      }),
    );

    await climbToRung4(r);
    expect(r.loads.at(-1)?.url).toBe('http://good.example/1.ts');
  });

  it('falls through to live container fallback (.ts -> .m3u8) when all alternates are canonical duplicates', async () => {
    const r = rig({
      'http://edge.example/live/1.ts?token=a': [],
      'http://edge.example/live/1.m3u8?token=a': [],
    });
    // No firstFrame yet -> container fallback is eligible
    r.service.tune(
      live('http://edge.example/live/1.ts?token=a', {
        alternates: [resolved('http://edge.example/live/1.ts?token=b')],
      }),
    );
    await tick(0);
    await climbToRung4(r);
    expect(r.loads.at(-1)?.url).toBe('http://edge.example/live/1.m3u8?token=a');
  });

  it('clears failedCanonicalUrls on a new tune so the same endpoint can be tried again later', async () => {
    const r = rig({
      'http://p.example/live/1.ts?token=1': [],
      'http://p.example/live/1.ts?token=2': [],
      'http://other.example/live/2.ts': [],
    });
    await playing(
      r,
      live('http://p.example/live/1.ts?token=1', {
        alternates: [resolved('http://p.example/live/1.ts?token=2')],
      }),
    );
    await climbToRung4(r);
    expect(status(r)).toEqual(failed('network'));

    // New tune clears failedCanonicalUrls
    await playing(
      r,
      live('http://other.example/live/2.ts', {
        alternates: [resolved('http://p.example/live/1.ts?token=2')],
      }),
    );
    await climbToRung4(r);
    expect(r.loads.at(-1)?.url).toBe('http://p.example/live/1.ts?token=2');
  });
});
