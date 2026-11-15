import { describe, expect, it } from 'vitest';
import { faultRate, faultsFor, judgeFault } from '../src/gates/fault-judge.ts';
import type { SimLogEntry } from '../src/gates/sim-log.ts';
import { entry, line, next, slow } from './gate-player-fixtures.ts';

const run = (fault: string, outcome: string | null) =>
  line({ fault, faultOutcome: outcome, zaps: 1 });

describe('judgeFault', () => {
  it('accepts a dropped stream that is requested again in time', () => {
    const entries = [entry(0, 5000), entry(5300, 3000)];
    expect(judgeFault('drop5', run('drop5', 'recovered'), entries, '1001')).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it('fails drop5 without a reconnect, a late one or a missed outcome', () => {
    expect(
      judgeFault('drop5', run('drop5', 'recovered'), [entry(0, 5000)], '1001').failures[0],
    ).toMatch(/no reconnect/);
    const late = judgeFault(
      'drop5',
      run('drop5', 'recovered'),
      [entry(0, 5000), entry(15001, 10)],
      '1001',
    );
    expect(late.failures[0]).toMatch(/10001 ms after the drop/);
    const missed = judgeFault(
      'drop5',
      run('drop5', 'missed'),
      [entry(0, 5000), entry(5100, 10)],
      '1001',
    );
    expect(missed.failures[0]).toMatch(/missed/);
  });

  it('accepts a 404 answered in time and fails a wrong outcome or an unanswered one', () => {
    const entries = [entry(0, 20, { status: 404 }), entry(1000, 20, { status: 404 })];
    expect(judgeFault('404', run('404', 'failed-in-time'), entries, '1001').failures).toEqual([]);
    expect(judgeFault('404', run('404', 'recovered'), entries, '1001').failures[0]).toMatch(
      /outcome recovered, expected failed-in-time/,
    );
    expect(
      judgeFault('404', run('404', 'failed-in-time'), [entry(0, 20)], '1001').failures[0],
    ).toMatch(/no 404/);
    const late = [entry(0, 20, { status: 404 }), entry(10_000, 20, { status: 404 })];
    expect(judgeFault('404', run('404', 'failed-in-time'), late, '1001').failures[0]).toMatch(
      /limit 10000/,
    );
  });

  it('requires the next request after a 509 to wait for the backoff', () => {
    const ok = [entry(0, 5, { status: 509 }), entry(2100, 5, { status: 509 })];
    expect(judgeFault('509', run('509', 'limited-backoff'), ok, '1001')).toEqual({
      failures: [],
      warnings: [],
    });
    const eager = [entry(0, 5, { status: 509 }), entry(500, 5, { status: 509 })];
    expect(judgeFault('509', run('509', 'limited-backoff'), eager, '1001').failures[0]).toMatch(
      /before the 2000 ms backoff/,
    );
    const single = judgeFault(
      '509',
      run('509', 'limited-backoff'),
      [entry(0, 5, { status: 509 })],
      '1001',
    );
    expect(single.failures).toEqual([]);
    expect(single.warnings[0]).toMatch(/backoff was not verified/);
    expect(
      judgeFault('509', run('509', 'limited-backoff'), [entry(0, 5)], '1001').failures[0],
    ).toMatch(/no 509/);
  });

  it('judges a notice like a limit: limited-backoff and the next request after 2,000 ms', () => {
    const notice = (start: number) =>
      entry(start, 3, { bytes: 23, query: { fault: 'text-notice' } });
    expect(
      judgeFault('notice', run('notice', 'limited-backoff'), [notice(0), notice(2200)], '1001'),
    ).toEqual({ failures: [], warnings: [] });
    expect(
      judgeFault('notice', run('notice', 'limited-backoff'), [notice(0), notice(800)], '1001')
        .failures,
    ).toEqual(['notice: next request came 797 ms after the notice, before the 2000 ms backoff']);
    expect(
      judgeFault('notice', run('notice', 'limited-backoff'), [notice(0)], '1001').warnings,
    ).toEqual(['notice: no second request within the stay; the backoff was not verified']);
    expect(
      judgeFault('notice', run('notice', 'failed-in-time'), [entry(0, 5000)], '1001').failures,
    ).toEqual([
      'notice: outcome failed-in-time, expected limited-backoff',
      'notice: the simulator answered no notice',
    ]);
  });

  it('judges a stall recovered by a new request within 10 s and no limit answer', () => {
    const stalled = (ms: number, over: Partial<SimLogEntry> = {}) =>
      entry(0, ms, { query: { fault: 'stall30s@2s' }, ...over });
    expect(
      judgeFault('stall', run('stall', 'recovered'), [stalled(7000), entry(7050, 9000)], '1001'),
    ).toEqual({ failures: [], warnings: [] });
    expect(
      judgeFault('stall', run('stall', 'recovered'), [stalled(12_000), entry(12_100, 10)], '1001')
        .failures,
    ).toEqual(['stall: the new request came 12100 ms after the first request, limit 10000 ms']);
    expect(
      judgeFault(
        'stall',
        run('stall', 'recovered'),
        [stalled(12_000), entry(12_100, 10)],
        '1001',
        8,
      ).failures,
    ).toEqual([]);
    expect(
      judgeFault(
        'stall',
        run('stall', 'recovered'),
        [stalled(18_000), entry(18_100, 10)],
        '1001',
        8,
      ).failures,
    ).toEqual(['stall: the new request came 18100 ms after the first request, limit 18000 ms']);
    expect(
      judgeFault('stall', run('stall', 'recovered'), [stalled(30_000)], '1001').failures,
    ).toEqual(['stall: no new request after the stall']);
    const leaked = judgeFault(
      'stall',
      run('stall', 'recovered'),
      [stalled(9000), entry(7000, 4, { status: 509, bytes: 0 })],
      '1001',
    );
    expect(leaked.failures).toEqual([
      'stall: 1 limit responses on demo: the stalled request stayed open beside the new one',
    ]);
    expect(leaked.warnings).toEqual(['stall: two demo streams were open together for 4 ms']);
  });

  it('passes a slow start left by a zap whose next request came after the slow one closed', () => {
    const entries = [slow(0, 800), next(805, 2000)];
    expect(judgeFault('slowstart', run('slowstart', 'left'), entries, '1001')).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it('fails a slow start whose request stayed open beside the next one, and warns about overlap', () => {
    const late = slow(0, 3000, { status: 509, bytes: 0 });
    const out = judgeFault('slowstart', run('slowstart', 'left'), [late, next(1800, 2000)], '1001');
    expect(out.failures).toEqual([
      'slowstart: 1 limit responses on demo: the slow request stayed open beside the next channel',
    ]);
    expect(out.warnings).toEqual(['slowstart: two demo streams were open together for 1200 ms']);
    const unseen = judgeFault(
      'slowstart',
      run('slowstart', 'left'),
      [slow(0, 800)],
      '1001',
    ).failures;
    expect(unseen).toEqual(['slowstart: the simulator saw no request after the zap']);
    const noFrame = line({ fault: 'slowstart', faultOutcome: 'left', zaps: 1 });
    noFrame.zapMs = { p50: null, p95: null, max: null };
    expect(
      judgeFault('slowstart', noFrame, [slow(0, 800), next(805, 10)], '1001').failures,
    ).toEqual(['slowstart: the zap away from the slow channel showed no frame']);
  });

  it('fails when the simulator saw nothing for the channel or the screen ran another fault', () => {
    const other = [entry(0, 100, { streamId: 1002, path: '/live/demo/demo/1002.ts' })];
    expect(judgeFault('404', run('', 'failed-in-time'), other, '1001').failures).toEqual([
      'the screen ran fault "", expected "404"',
      '404: the simulator saw no request for channel 1001',
    ]);
    expect(judgeFault('404', run('404', null), [], '1001').failures[0]).toMatch(/outcome null/);
  });

  it('judges a silent fault run bounded to 12 s with ladder retries and zero limit responses (#81)', () => {
    const stalled = (start: number, ms: number, over: Partial<SimLogEntry> = {}) =>
      entry(start, ms, { bytes: 0, query: { fault: 'stall30s@0s' }, ...over });
    const bounded = [
      stalled(0, 5000),
      stalled(5005, 2000),
      stalled(7010, 2000),
      next(20_000, 1000),
    ];
    expect(judgeFault('silent', run('silent', 'failed-in-time'), bounded, '1001')).toEqual({
      failures: [],
      warnings: [],
    });
    expect(
      judgeFault('silent', run('silent', 'failed-in-time'), [stalled(0, 5000)], '1001').failures[0],
    ).toMatch(/fewer than 2 requests/);
    const old23s = [stalled(0, 8000), stalled(9000, 4000), stalled(15_000, 8000)];
    expect(
      judgeFault('silent', run('silent', 'failed-in-time'), old23s, '1001').failures[0],
    ).toMatch(/limit 12000 ms/);
    const leaked = [stalled(0, 4500), stalled(4000, 5, { status: 509 })];
    expect(
      judgeFault('silent', run('silent', 'failed-in-time'), leaked, '1001').failures[0],
    ).toMatch(/1 limit responses on demo/);
  });

  it('fails a fault run whose line made no zap', () => {
    const l = line({ fault: '404', faultOutcome: 'failed-in-time', zaps: 0 });
    const out = judgeFault('404', l, [entry(0, 20, { status: 404 })], '1001');
    expect(out.failures).toEqual(['404: the screen made 0 zaps, requested 1']);
  });
});

describe('fault runs per target', () => {
  it('keeps the Android set and adds notice and stall on Apple simulators', () => {
    expect(faultsFor('android-tv')).toEqual(['drop5', '404', '509', 'slowstart', 'silent']);
    expect(faultsFor('tvos')).toEqual([
      'drop5',
      '404',
      '509',
      'notice',
      'stall',
      'slowstart',
      'silent',
    ]);
    expect(faultsFor('ios')).toEqual(faultsFor('tvos'));
  });

  it('stays long enough on the faulted channel for each fault and burst profile', () => {
    expect(['drop5', '404', '509', 'notice'].map((f) => faultRate(f as 'drop5'))).toEqual([
      0.1, 0.1, 0.1, 0.1,
    ]);
    expect(faultRate('drop5', 8)).toBe(0.05);
    expect(faultRate('404', 8)).toBe(0.1);
    expect(faultRate('stall')).toBe(0.05);
    expect(faultRate('silent')).toBe(0.05);
    expect(faultRate('slowstart', 8)).toBe(1.25);
  });
});
