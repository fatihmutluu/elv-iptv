import { describe, expect, it } from 'vitest';
import { buildEpgGateScript, epgGateLine, summarizeEpgGateMetrics } from './epg-gate-metrics';
import { parseEpgGateUrl } from './epg-routes';
import {
  createSyntheticEpgCatalog,
  EPG_GATE_BASE_NOW_MS,
  generateSyntheticProgrammes,
  parseSyntheticChannelIndex,
} from './epg-synthetic';

const HOUR = 3_600_000;

describe('parseEpgGateUrl', () => {
  it('parses elviptv://gate/epg with defaults and clamped query params', () => {
    expect(parseEpgGateUrl(null)).toBeUndefined();
    expect(parseEpgGateUrl('elviptv://gate/list')).toBeUndefined();
    expect(parseEpgGateUrl('elviptv://gate/epg')).toEqual({
      channels: 1000,
      days: 7,
      moves: 220,
      auto: true,
    });
    expect(parseEpgGateUrl('elviptv://gate/epg?channels=500&days=3&moves=50&auto=0')).toEqual({
      channels: 500,
      days: 3,
      moves: 50,
      auto: false,
    });
    expect(parseEpgGateUrl('elviptv://gate/epg?channels=99999&days=99&moves=1')).toEqual({
      channels: 5000,
      days: 14,
      moves: 10,
      auto: true,
    });
  });
});

describe('createSyntheticEpgCatalog (1,000ch × 7d O(1) windowing)', () => {
  it('generates deterministic staggered programmes and >= 5 min gaps strictly within queried windows', async () => {
    const dataset = createSyntheticEpgCatalog({ channels: 1000, days: 7 });
    expect(dataset.category.row.itemCount).toBe(1000);
    expect(dataset.totalEstimatedProgrammes).toBe(336_000);
    expect(parseSyntheticChannelIndex('gate:epg:live:1')).toBe(0);
    expect(parseSyntheticChannelIndex('gate:epg:live:1000')).toBe(999);
    expect(parseSyntheticChannelIndex('invalid')).toBe(-1);

    const ch0 = await dataset.channelSource.loadItem(0);
    const ch999 = await dataset.channelSource.loadItem(999);
    expect(ch0?.key).toBe('gate:epg:live:1');
    expect(ch999?.key).toBe('gate:epg:live:1000');

    // Query a 6-hour window for channels 0, 1, 2 (channel 2 has intentional 15m gaps)
    const fromMs = EPG_GATE_BASE_NOW_MS;
    const toMs = fromMs + 6 * HOUR;
    const window = await dataset.catalog.epgWindow?.(
      ['gate:epg:live:1', 'gate:epg:live:2', 'gate:epg:live:3'],
      fromMs,
      toMs,
    );
    expect(window?.['gate:epg:live:1']?.length).toBeGreaterThan(3);
    expect(window?.['gate:epg:live:2']?.length).toBeGreaterThan(3);
    const ch2Progs = window?.['gate:epg:live:3'] ?? [];
    expect(ch2Progs.length).toBeGreaterThan(3);
    // Verify at least one >= 5 min gap exists on channel index 2
    let foundGap = false;
    for (let i = 1; i < ch2Progs.length; i++) {
      const prev = ch2Progs[i - 1];
      const curr = ch2Progs[i];
      if (prev && curr && curr.start - prev.stop >= 5 * 60_000) {
        foundGap = true;
        break;
      }
    }
    expect(foundGap).toBe(true);

    // Out-of-bounds or invalid window returns empty
    expect(generateSyntheticProgrammes(-1, fromMs, toMs)).toEqual([]);
    expect(generateSyntheticProgrammes(0, toMs, fromMs)).toEqual([]);
    dataset.channelSource.dispose();
  });

  it('preserves ItemRow referential stability with a bounded <= 64 entry LRU cache', () => {
    const dataset = createSyntheticEpgCatalog({ channels: 200, days: 7 });
    const first0 = dataset.channelSource.get(0);
    expect(first0).toBeDefined();
    expect(dataset.channelSource.get(0)).toBe(first0);

    // Fill 64 distinct other entries so index 0 is evicted from the 64-entry LRU
    for (let i = 1; i <= 64; i++) {
      dataset.channelSource.get(i);
    }
    const ref64 = dataset.channelSource.get(64);
    expect(dataset.channelSource.get(64)).toBe(ref64);
    const reloaded0 = dataset.channelSource.get(0);
    expect(reloaded0).toEqual(first0);
    expect(reloaded0).not.toBe(first0);

    dataset.channelSource.dispose();
    expect(dataset.channelSource.get(0)).toBeUndefined();
  });
});

describe('epg-gate-metrics', () => {
  it('builds a deterministic vertical+horizontal D-pad script and summarizes pass/fail verdict', () => {
    const script = buildEpgGateScript(1000, 220);
    expect(script).toHaveLength(220);
    // Probes row 2 (index 2, reached after exactly 2 downs) with horizontal gap pan
    expect(script.slice(0, 5)).toEqual(['down', 'down', 'right', 'right', 'left']);
    expect(script.filter((k) => k === 'down').length).toBeGreaterThanOrEqual(190);
    expect(script.filter((k) => k === 'right').length).toBeGreaterThan(0);
    expect(script.filter((k) => k === 'left').length).toBeGreaterThan(0);
    expect(script.filter((k) => k === 'up').length).toBeGreaterThan(0);

    // Small channel counts clamp trailing 'up' moves to actual rows descended
    const small = buildEpgGateScript(10, 220);
    const smallDowns = small.filter((k) => k === 'down').length;
    const smallUps = small.filter((k) => k === 'up').length;
    expect(smallDowns).toBe(9);
    expect(smallUps).toBeLessThanOrEqual(smallDowns);

    const passMetrics = summarizeEpgGateMetrics({
      channels: 1000,
      days: 7,
      totalEstimatedProgrammes: 336_000,
      keyLatenciesMs: [4, 6, 8, 10, 12],
      maxJsTaskMs: 7.5,
      framesOver16Ms: 0,
      focusContinuityOk: true,
    });
    expect(passMetrics.passed).toBe(true);
    expect(passMetrics.keyToHighlightP95Ms).toBe(12);
    expect(epgGateLine(passMetrics)).toMatch(/^ELV_GATE \{"gate":"epg"/);

    const failMetrics = summarizeEpgGateMetrics({
      channels: 1000,
      days: 7,
      totalEstimatedProgrammes: 336_000,
      keyLatenciesMs: [5, 110],
      maxJsTaskMs: 110,
      framesOver16Ms: 1,
      focusContinuityOk: true,
    });
    expect(failMetrics.passed).toBe(false);
  });
});
