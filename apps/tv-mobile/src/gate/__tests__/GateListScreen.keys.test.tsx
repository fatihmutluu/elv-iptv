import type { KeyInput } from '@elv/focus-core';
import { act, render, waitFor } from '@testing-library/react-native';
import { GateListScreen } from '../GateListScreen';

let mockOnInput: ((k: KeyInput) => void) | undefined;
jest.mock('@elv/ui-kit', () => ({
  ...jest.requireActual('@elv/ui-kit'),
  useTvKeySource: (onInput: (k: KeyInput) => void) => {
    mockOnInput = onInput;
  },
}));

describe('GateListScreen real keys', () => {
  afterEach(() => jest.restoreAllMocks());

  it('resolves moves that return to the same index within one frame without losses', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await render(<GateListScreen params={{ items: 1000, auto: false, rate: 20, moves: 10 }} />);
    await act(async () => {
      mockOnInput?.({ key: 'down', action: 'press', time: performance.now() });
      mockOnInput?.({ key: 'up', action: 'press', time: performance.now() });
    });
    await waitFor(
      () => expect(log.mock.calls.some((c) => String(c[0]).startsWith('ELV_GATE '))).toBe(true),
      { timeout: 6000 },
    );
    const line = String(log.mock.calls.find((c) => String(c[0]).startsWith('ELV_GATE '))?.[0]);
    const metrics = JSON.parse(line.slice('ELV_GATE '.length));
    expect(metrics.moves).toBe(2);
    expect(metrics.losses).toBe(0);
    expect(metrics.keyToHighlightMs.max).toBeLessThan(1000);
  });
});
