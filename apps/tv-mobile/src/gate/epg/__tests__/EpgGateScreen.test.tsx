import { act, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { EpgGateScreen } from '../EpgGateScreen';

describe('EpgGateScreen', () => {
  const origOs = Platform.OS;

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { value: origOs, configurable: true });
  });

  it('mounts real EpgGridView, runs scripted navigation, and prints an ELV_GATE JSON line', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await render(<EpgGateScreen params={{ channels: 20, days: 2, moves: 12, auto: true }} />);
      expect(screen.getByTestId('epg-gate-screen')).toBeTruthy();
      expect(screen.getByTestId('live-epg-view')).toBeTruthy();

      // Advance past warmup + 12 scripted steps
      for (let i = 0; i < 30; i++) {
        await act(async () => {
          jest.advanceTimersByTime(50);
          await Promise.resolve();
        });
      }

      const gateCall = logSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].startsWith('ELV_GATE '),
      );
      expect(gateCall).toBeDefined();
      const payload = JSON.parse(String(gateCall?.[0]).slice('ELV_GATE '.length)) as Record<
        string,
        unknown
      >;
      expect(payload.gate).toBe('epg');
      expect(payload.channels).toBe(20);
      expect(payload.days).toBe(2);
      expect(payload.steps).toBe(12);
      expect(payload.focusContinuityOk).toBe(true);
      expect(payload.passed).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
