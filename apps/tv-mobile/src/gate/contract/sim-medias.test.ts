import { describe, expect, it } from 'vitest';
import { maxOpenMedias } from './sim-medias';

describe('maxOpenMedias', () => {
  it('two overlapping TS requests of demo count 2', () => {
    const entries = [
      { t: '2026-11-15T10:00:02.000Z', ms: 2000, path: '/live/demo/***/1001.ts', account: 'demo' },
      { t: '2026-11-15T10:00:02.500Z', ms: 1000, path: '/live/demo/***/1002.ts', account: 'demo' },
    ];
    expect(maxOpenMedias(entries, 'demo')).toBe(2);
  });

  it('back to back count 1', () => {
    const entries = [
      { t: '2026-11-15T10:00:01.000Z', ms: 1000, path: '/live/demo/***/1001.ts', account: 'demo' },
      { t: '2026-11-15T10:00:02.000Z', ms: 1000, path: '/live/demo/***/1002.ts', account: 'demo' },
    ];
    expect(maxOpenMedias(entries, 'demo')).toBe(1);
  });

  it('HLS segments and other accounts are ignored', () => {
    const entries = [
      {
        t: '2026-11-15T10:00:02.000Z',
        ms: 2000,
        path: '/hls/h264-aac-720p25/seg0.ts',
        account: 'demo',
      },
      {
        t: '2026-11-15T10:00:02.000Z',
        ms: 2000,
        path: '/live/demo/***/1001.m3u8',
        account: 'demo',
      },
      {
        t: '2026-11-15T10:00:02.000Z',
        ms: 2000,
        path: '/live/other/***/1001.ts',
        account: 'other',
      },
    ];
    expect(maxOpenMedias(entries, 'demo')).toBe(0);
  });
});
