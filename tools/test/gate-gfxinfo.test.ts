import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGfxinfo } from '../src/gates/gfxinfo.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/gate/${name}`, import.meta.url), 'utf8');

describe('parseGfxinfo', () => {
  it('reads both janky metrics and the percentiles of a real run', () => {
    expect(parseGfxinfo(fixture('gfxinfo-run.txt'))).toEqual({
      totalFrames: 605,
      jankyPercent: 73.06,
      legacyJankyPercent: 0.5,
      p50: 17,
      p90: 18,
      p95: 18,
      p99: 19,
    });
  });

  it('treats zero rendered frames as no data', () => {
    expect(parseGfxinfo(fixture('gfxinfo-empty.txt'))).toBeUndefined();
  });

  it('returns undefined for output that is not gfxinfo', () => {
    expect(parseGfxinfo('No process found for: x')).toBeUndefined();
    expect(parseGfxinfo('')).toBeUndefined();
  });

  it('accepts output without the legacy line', () => {
    const text = [
      'Total frames rendered: 10',
      'Janky frames: 1 (10.00%)',
      '50th percentile: 5ms',
      '90th percentile: 6ms',
      '95th percentile: 7ms',
      '99th percentile: 8ms',
    ].join('\r\n');
    expect(parseGfxinfo(text)).toEqual({
      totalFrames: 10,
      jankyPercent: 10,
      p50: 5,
      p90: 6,
      p95: 7,
      p99: 8,
    });
  });
});
