import type { KeyInput } from '@elv/focus-core';
import { RemoteKeysProvider } from '@elv/ui-kit';
import { act, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { GateListScreen } from '../GateListScreen';
import { advance, gateLines, onlyGateMetrics } from './gate-test-utils';

let mockOnInput: ((k: KeyInput) => void) | undefined;
let mockRealSource = false;
jest.mock('@elv/ui-kit', () => {
  const actual = jest.requireActual('@elv/ui-kit');
  return {
    ...actual,
    useTvKeySource: (onInput: (k: KeyInput) => void) => {
      if (mockRealSource) return actual.useTvKeySource(onInput);
      mockOnInput = onInput;
    },
  };
});

const manual = { items: 1000, auto: false, rate: 20, moves: 10, stall: 0 };

describe('GateListScreen real keys', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, 'OS', 'android');
  });
  afterEach(() => {
    mockRealSource = false;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('resolves moves that return to the same index within one frame without losses', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await render(<GateListScreen params={manual} />);
    await act(async () => {
      mockOnInput?.({ key: 'down', action: 'press', time: performance.now() });
      mockOnInput?.({ key: 'up', action: 'press', time: performance.now() });
    });
    await advance(1900);
    expect(gateLines(log)).toEqual([]);
    await advance(200);
    const metrics = onlyGateMetrics(log);
    expect(metrics.moves).toBe(2);
    expect(metrics.losses).toBe(0);
    expect(metrics.keyToHighlightMs.max).toBeLessThan(100);
  });

  it('moves on an Android TV tap, which arrives only as the release, and measures from it', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await render(<GateListScreen params={manual} />);
    await advance(400);
    const upAt = performance.now() - 50;
    await act(async () => {
      mockOnInput?.({ key: 'down', action: 'up', time: upAt });
    });
    expect(screen.getByTestId('gate-list-row-1').props.accessibilityState.selected).toBe(true);
    await advance(2100);
    const metrics = onlyGateMetrics(log);
    expect(metrics.moves).toBe(1);
    expect(metrics.losses).toBe(0);
    expect(metrics.keyToHighlightMs.max).toBeGreaterThanOrEqual(50);
    expect(metrics.keyToHighlightMs.max).toBeLessThan(150);
  });

  it('steps when the arrow goes down and measures from the down receipt', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await render(<GateListScreen params={manual} />);
    await advance(400);
    const downAt = performance.now() - 300;
    await act(async () => {
      mockOnInput?.({ key: 'down', action: 'down', time: downAt });
    });
    expect(screen.getByTestId('gate-list-row-1').props.accessibilityState.selected).toBe(true);
    await advance(32);
    await act(async () => {
      mockOnInput?.({ key: 'down', action: 'up', time: performance.now() });
    });
    await advance(2100);
    const metrics = onlyGateMetrics(log);
    expect(metrics.moves).toBe(1);
    expect(metrics.losses).toBe(0);
    expect(metrics.keyToHighlightMs.max).toBeGreaterThanOrEqual(300);
    expect(metrics.keyToHighlightMs.max).toBeLessThan(400);
  });

  describe('raw Android keys', () => {
    type Raw =
      | { action: 'down' | 'up'; keyCode: number; canceled: boolean; ageMs: number }
      | { action: 'blur' };
    const DOWN = 20;
    const BACK = 4;

    async function mountAndroid() {
      mockRealSource = true;
      jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      let listener: ((e: Raw) => void) | undefined;
      const source = {
        addListener: (l: (e: Raw) => void) => {
          listener = l;
          return { remove: () => {} };
        },
      };
      await render(
        <RemoteKeysProvider android={source}>
          <GateListScreen params={manual} />
        </RemoteKeysProvider>,
      );
      const send = (e: Raw) => act(async () => listener?.(e));
      const key = (action: 'down' | 'up', keyCode: number) =>
        send({ action, keyCode, canceled: false, ageMs: 0 });
      return { log, send, key };
    }

    it('a 2000 ms hold of Down gives one press, one page, then repeats until release', async () => {
      const { log, key } = await mountAndroid();
      await key('down', DOWN);
      await advance(1984);
      await advance(15, 15);
      await key('up', DOWN);
      await advance(3000);
      const metrics = onlyGateMetrics(log);
      expect(metrics.moves).toBe(13);
      expect(metrics.intents).toEqual({
        select: 0,
        long: 0,
        back: 0,
        backLong: 0,
        edge: 0,
        key: 0,
      });
    });

    it('a key held before mount does not step the new screen', async () => {
      const { log, key } = await mountAndroid();
      await key('up', DOWN);
      await advance(3000);
      expect(gateLines(log)).toEqual([]);
      expect(screen.getByTestId('gate-list-row-0').props.accessibilityState.selected).toBe(true);
    });

    it('a held Back fires backLong once', async () => {
      const { log, key } = await mountAndroid();
      await key('down', BACK);
      await advance(600);
      await key('up', BACK);
      await advance(3000);
      const metrics = onlyGateMetrics(log);
      expect(metrics.intents.backLong).toBe(1);
      expect(metrics.intents.back).toBe(0);
    });

    it('blur stops a held key', async () => {
      const { log, key, send } = await mountAndroid();
      await key('down', DOWN);
      await advance(700);
      await send({ action: 'blur' });
      await advance(3000);
      expect(onlyGateMetrics(log).moves).toBe(3);
    });
  });
});
