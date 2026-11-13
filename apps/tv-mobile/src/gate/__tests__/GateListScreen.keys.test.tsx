import type { KeyInput } from '@elv/focus-core';
import { act, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { GateListScreen } from '../GateListScreen';
import { advance, gateLines, onlyGateMetrics } from './gate-test-utils';

let mockOnInput: ((k: KeyInput) => void) | undefined;
jest.mock('@elv/ui-kit', () => ({
  ...jest.requireActual('@elv/ui-kit'),
  useTvKeySource: (onInput: (k: KeyInput) => void) => {
    mockOnInput = onInput;
  },
}));

const manual = { items: 1000, auto: false, rate: 20, moves: 10, stall: 0 };

describe('GateListScreen real keys', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, 'OS', 'android');
  });
  afterEach(() => {
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
});
