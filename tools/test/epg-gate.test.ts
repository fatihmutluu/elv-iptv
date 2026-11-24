import { describe, expect, it, vi } from 'vitest';
import {
  type EpgGateLine,
  judgeEpgGate,
  parseEpgGateLine,
  runEpgGate,
} from '../src/gates/epg-gate.ts';
import type { GateDevice } from '../src/gates/gate-device.ts';
import {
  compareImport,
  GUIDE_DURATION_BUDGET_MS,
  type ImportResult,
  parseImportLine,
  runImportGate,
} from '../src/gates/import-gate.ts';

const PASSING_EPG_LINE: EpgGateLine = {
  gate: 'epg',
  channels: 1000,
  days: 7,
  totalEstimatedProgrammes: 336_000,
  steps: 220,
  keyToHighlightP50Ms: 8.2,
  keyToHighlightP95Ms: 18.4,
  keyToHighlightMaxMs: 32.1,
  maxJsTaskMs: 11.4,
  framesOver16Ms: 0,
  focusContinuityOk: true,
  passed: true,
};

function makeFakeDevice(opts: { simHost?: string; logs: string[]; crashes?: string[] }): {
  device: GateDevice;
  startedUrls: string[];
} {
  const startedUrls: string[] = [];
  let readIdx = 0;
  const device: GateDevice = {
    simHost: opts.simHost ?? '127.0.0.1:7878',
    describe: async () => ({ platform: 'tvos', model: 'AppleTV' }),
    install: vi.fn(async () => undefined),
    start: vi.fn(async (url: string) => {
      startedUrls.push(url);
    }),
    stop: vi.fn(async () => undefined),
    readLog: vi.fn(async () => {
      const next = opts.logs[Math.min(readIdx, opts.logs.length - 1)] ?? '';
      readIdx++;
      return next;
    }),
    crashesSince: vi.fn(async () => opts.crashes ?? []),
    memoryMb: vi.fn(async () => 180),
    close: vi.fn(async () => undefined),
  };
  return { device, startedUrls };
}

describe('epg-gate parsing, judging & runner (#6)', () => {
  it('parses the last well-formed ELV_GATE epg line and ignores unrelated lines', () => {
    const log = [
      'noise line',
      'ELV_GATE {"gate":"list","moves":10}',
      `I/ReactNativeJS: ELV_GATE ${JSON.stringify(PASSING_EPG_LINE)}`,
      'ELV_GATE {truncated',
    ].join('\n');
    expect(parseEpgGateLine(log)).toEqual(PASSING_EPG_LINE);
    expect(parseEpgGateLine('no gate here')).toBeUndefined();
  });

  it('judges pass, key-to-highlight >= 100ms, focus continuity failure, and gfxinfo jank', () => {
    expect(judgeEpgGate(PASSING_EPG_LINE).ok).toBe(true);

    const slow = judgeEpgGate({
      ...PASSING_EPG_LINE,
      keyToHighlightP95Ms: 105,
      keyToHighlightMaxMs: 140,
    });
    expect(slow.ok).toBe(false);
    expect(slow.failures.length).toBe(2);

    const slowWarn = judgeEpgGate(
      { ...PASSING_EPG_LINE, keyToHighlightP95Ms: 105, keyToHighlightMaxMs: 140 },
      { budgets: 'warn' },
    );
    expect(slowWarn.ok).toBe(true);
    expect(slowWarn.warnings.length).toBe(2);

    const lostFocus = judgeEpgGate(
      { ...PASSING_EPG_LINE, focusContinuityOk: false },
      { budgets: 'warn' },
    );
    expect(lostFocus.ok).toBe(false);

    const janky = judgeEpgGate(PASSING_EPG_LINE, {
      frames: { totalFrames: 200, jankyPercent: 7.5, p50: 8, p90: 14, p95: 18, p99: 28 },
    });
    expect(janky.ok).toBe(false);
  });

  it('runs EPG gate over GateDevice (tvOS/Android TV) and emits structured outcome', async () => {
    const { device, startedUrls } = makeFakeDevice({
      logs: ['', `ELV_GATE ${JSON.stringify(PASSING_EPG_LINE)}`],
    });
    const out = await runEpgGate({
      exec: vi.fn(async () => ({ ok: true, code: 0, output: '' })),
      target: 'tvos',
      device,
      channels: 1000,
      days: 7,
      moves: 220,
      sleep: async () => undefined,
    });
    expect(startedUrls).toEqual(['elviptv://gate/epg?channels=1000&days=7&moves=220&auto=1']);
    expect(device.start).toHaveBeenCalledWith(
      'elviptv://gate/epg?channels=1000&days=7&moves=220&auto=1',
      { resetFrames: true },
    );
    expect(out.outcome.ok).toBe(true);
    expect(out.line).toEqual(PASSING_EPG_LINE);
  });
});

describe('import-gate XMLTV guide budget & tvOS target (#25)', () => {
  const baseResult: ImportResult = {
    account: 'large',
    batch: 5000,
    maxBody: 4096,
    rows: 100_000,
    durationMs: 12_000,
    maxStallMs: 35,
    guideDurationMs: 18_500,
    guideProgrammes: 336_000,
    guideMatchedChannels: 5_000,
    guideMaxStallMs: 28,
  };

  it('parses ELV_GATE_IMPORT guide metrics cleanly', () => {
    const parsed = parseImportLine(`ELV_GATE_IMPORT ${JSON.stringify(baseResult)}`);
    expect(parsed).toEqual(baseResult);
  });

  it('enforces < 60s XMLTV guide duration budget and guideError failure', () => {
    expect(compareImport(baseResult, baseResult).ok).toBe(true);

    const overBudget = compareImport(
      { ...baseResult, guideDurationMs: GUIDE_DURATION_BUDGET_MS + 1 },
      baseResult,
    );
    expect(overBudget.ok).toBe(false);
    expect(overBudget.failures[0]).toContain('guide duration');

    const overBudgetWarn = compareImport(
      { ...baseResult, guideDurationMs: GUIDE_DURATION_BUDGET_MS + 1 },
      baseResult,
      { budgets: 'warn' },
    );
    expect(overBudgetWarn.ok).toBe(true);
    expect(overBudgetWarn.warnings.length).toBeGreaterThan(0);

    const errored = compareImport({ ...baseResult, guideError: 'network/timeout' }, baseResult);
    expect(errored.ok).toBe(false);
    expect(errored.failures[0]).toContain('guide import failed');
  });

  it('launches elviptv://gate/import with &guide=1 on tvos GateDevice', async () => {
    const { device, startedUrls } = makeFakeDevice({
      simHost: '127.0.0.1:7878',
      logs: [`ELV_GATE_IMPORT ${JSON.stringify(baseResult)}`],
    });
    const sim = {
      ensure: vi.fn(async () => ({ reused: true, stop: vi.fn(async () => undefined) })),
    };
    const { result, device: deviceMeta } = await runImportGate({
      exec: vi.fn(async () => ({ ok: true, code: 0, output: '' })),
      sim,
      target: 'tvos',
      device,
      guide: true,
      runs: 1,
      sleep: async () => undefined,
    });
    expect(startedUrls).toEqual([
      'elviptv://gate/import?host=127.0.0.1:7878&account=large&batch=5000&maxBody=4096&guide=1',
    ]);
    expect(deviceMeta).toEqual({ platform: 'tvos', model: 'AppleTV' });
    expect(result.guideDurationMs).toBe(18_500);
    expect(result.guideProgrammes).toBe(336_000);
    expect(result.guideMatchedChannels).toBe(5_000);
  });
});
