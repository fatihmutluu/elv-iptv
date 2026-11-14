import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startReadProbe } from './read-probe';

describe('startReadProbe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads every 50 ms and reports the longest read', async () => {
    let clock = 0;
    const costs = [3, 40, 7];
    const read = vi.fn(async () => {
      clock += costs.shift() ?? 1;
    });
    const probe = startReadProbe(read, () => clock);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    const stopped = probe.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(await stopped).toEqual({ maxReadMs: 40, reads: 4, readErrors: 0 });
    const calls = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(read).toHaveBeenCalledTimes(calls);
  });

  it('counts failed reads and keeps probing', async () => {
    const read = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue(undefined);
    const probe = startReadProbe(read, () => 0);
    await vi.advanceTimersByTimeAsync(60);
    const stopped = probe.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(await stopped).toEqual({ maxReadMs: 0, reads: 2, readErrors: 1 });
  });
});
