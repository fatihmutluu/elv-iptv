import type { PlayerEngine } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { act, render, waitFor } from '@testing-library/react-native';
import { ContractGateScreen } from '../ContractGateScreen';

jest.mock('@elv/engine-aether', () => ({
  createAetherEngine: () => null,
  AetherSurface: () => null,
}));

jest.mock('@elv/engine-media3', () => ({
  createMedia3Engine: () => null,
  Media3Surface: () => null,
}));

describe('ContractGateScreen', () => {
  it('runs every case and prints one line naming the failures', async () => {
    const lines: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      if (typeof msg === 'string') lines.push(msg);
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      if (typeof msg === 'string') lines.push(msg);
    });

    let deleteCalls = 0;
    const fakeFetch = jest.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') {
        deleteCalls += 1;
        return { ok: true, json: async () => [] };
      }
      if (deleteCalls === 2) {
        return {
          ok: true,
          json: async () => [
            {
              t: '2026-11-15T10:00:02.000Z',
              ms: 2000,
              path: '/live/demo/***/1001.ts',
              account: 'demo',
            },
            {
              t: '2026-11-15T10:00:02.500Z',
              ms: 1000,
              path: '/live/demo/***/1002.ts',
              account: 'demo',
            },
          ],
        };
      }
      return {
        ok: true,
        json: async () => [
          {
            t: '2026-11-15T10:00:01.000Z',
            ms: 500,
            path: '/live/demo/***/1001.ts',
            account: 'demo',
          },
        ],
      };
    });

    const createEngine = () =>
      createFakePlayerEngine({
        scripts: {
          'http://127.0.0.1:7878/live/demo/demo/1003.ts?fault=status=404': [
            { afterMs: 5, emit: 'error', error: { code: 'http-404', httpStatus: 404 } },
          ],
        },
        now: () => Date.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        anchorOnPlayPause: true,
      });

    try {
      render(
        <ContractGateScreen
          params={{ host: '127.0.0.1:7878', account: 'demo' }}
          createEngine={createEngine}
          fetchImpl={fakeFetch}
          quietMs={25}
          maxSettleMs={300}
        />,
      );

      await waitFor(
        () => {
          expect(lines.some((line) => line.startsWith('ELV_GATE_CONTRACT '))).toBe(true);
        },
        { timeout: 15_000 },
      );

      const contractLines = lines.filter((line) => line.startsWith('ELV_GATE_CONTRACT '));
      expect(contractLines).toHaveLength(1);
      const firstLine = contractLines[0] ?? '';
      const payload = JSON.parse(firstLine.slice('ELV_GATE_CONTRACT '.length)) as {
        passed: number;
        failed: { name: string; message: string }[];
      };
      expect(payload.passed).toBe(7);
      expect(payload.failed).toHaveLength(1);
      expect(payload.failed[0]?.name).toBe('a newer load replaces the media and never holds two');
      expect(payload.failed[0]?.message).toContain('two medias were open at once');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('stops and releases rawEngine and clears settle timers immediately on unmount', async () => {
    jest.useFakeTimers();
    const lines: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      if (typeof msg === 'string' && msg.startsWith('ELV_GATE_CONTRACT ')) lines.push(msg);
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      if (typeof msg === 'string' && msg.startsWith('ELV_GATE_CONTRACT ')) lines.push(msg);
    });

    const activeTimers = new Set<unknown>();
    const origSet = globalThis.setTimeout;
    const origClear = globalThis.clearTimeout;
    const setSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: (...cbArgs: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const id = origSet(() => {
        activeTimers.delete(id);
        fn(...args);
      }, ms);
      if ((ms ?? 0) > 0) activeTimers.add(id);
      return id;
    }) as typeof setTimeout);
    const clearSpy = jest.spyOn(globalThis, 'clearTimeout').mockImplementation(((
      id?: ReturnType<typeof setTimeout>,
    ) => {
      activeTimers.delete(id);
      origClear(id);
    }) as typeof clearTimeout);

    let created = 0;
    let stopped = false;
    let released = false;
    const createEngine = (): PlayerEngine => {
      created += 1;
      const fake = createFakePlayerEngine({
        now: () => performance.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        anchorOnPlayPause: true,
      });
      return {
        ...fake,
        stop(attempt) {
          stopped = true;
          fake.stop(attempt);
        },
        release() {
          released = true;
          fake.release();
        },
      };
    };

    try {
      const view = await render(
        <ContractGateScreen
          params={{ host: '127.0.0.1:7878', account: 'demo' }}
          createEngine={createEngine}
          fetchImpl={async () => ({ ok: true, json: async () => [] })}
          quietMs={1_000}
          maxSettleMs={12_000}
        />,
      );

      await act(async () => {
        await jest.advanceTimersByTimeAsync(200);
      });
      expect(created).toBe(1);
      expect(released).toBe(false);
      expect(activeTimers.size).toBeGreaterThan(0);

      await view.unmount();
      expect(stopped).toBe(true);
      expect(released).toBe(true);
      expect(activeTimers.size).toBe(0);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(30_000);
      });
      expect(created).toBe(1);
      expect(lines).toHaveLength(0);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
