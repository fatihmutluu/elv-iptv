import { act } from '@testing-library/react-native';

/** The `ELV_GATE` lines printed through a console spy. */
export function gateLines(spy: jest.SpyInstance): string[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('ELV_GATE '));
}

/** The metrics of the only `ELV_GATE` line printed through `spy`; throws unless there is exactly one. */
export function onlyGateMetrics(spy: jest.SpyInstance): Record<string, unknown> & {
  moves: number;
  losses: number;
  keyToHighlightMs: { p50: number; p95: number; max: number };
} {
  const lines = gateLines(spy);
  if (lines.length !== 1) throw new Error(`expected one ELV_GATE line, got ${lines.length}`);
  return JSON.parse((lines[0] ?? '').slice('ELV_GATE '.length));
}

/**
 * Moves Jest's fake clock forward by `ms` in frame-sized steps, each inside `act`, so timers, animation frames and
 * React commits interleave as they do on a device and the test never waits for real time.
 */
export async function advance(ms: number, step = 16): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await act(async () => {
      jest.advanceTimersByTime(step);
    });
  }
}
