import type { PlayerEngine } from '@elv/playback';
import {
  createFakePlayerEngine,
  type FakePlayerEngine,
  type FakeStep,
} from '@elv/playback/testing';
import { act, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { advance } from '../../__tests__/gate-test-utils';
import { PlayerGateScreen } from '../PlayerGateScreen';
import type { PlayerGateParams } from '../player-routes';

jest.mock('@elv/ui-kit', () => ({
  ...jest.requireActual('@elv/ui-kit'),
  useTvKeySource: () => {},
}));

jest.mock('@elv/engine-media3', () => ({
  createMedia3Engine: () => null,
  Media3Surface: () => null,
}));

const HOST = 'http://10.0.2.2:7878/live/demo/demo';
const params: PlayerGateParams = {
  host: '10.0.2.2:7878',
  account: 'demo',
  channels: ['1001', '1002'],
  zaps: 1,
  rate: 0.05,
  fault: '',
  stream: 'ts',
};

function setup(scripts?: Record<string, readonly FakeStep[]>): FakePlayerEngine {
  return createFakePlayerEngine({
    scripts,
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}

const asEngine = (engine: PlayerEngine) => () => engine;

describe('PlayerGateScreen OsdClock rAF gating', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('schedules zero rAF ticks when anchor is undefined or rate is 0, and ticks only while rate > 0', async () => {
    const raf = jest.spyOn(globalThis, 'requestAnimationFrame');
    const engine = setup({
      [`${HOST}/1001.ts`]: [{ afterMs: 0, emit: 'state', state: 'opening' }],
    });

    const view = await render(<PlayerGateScreen params={params} createEngine={asEngine(engine)} />);
    expect(screen.getByTestId('osd-clock')).toHaveTextContent('--:--');
    expect(raf).not.toHaveBeenCalled();

    await advance(1_000);
    expect(raf).not.toHaveBeenCalled();

    await act(async () => {
      engine.emit({ attempt: 1, type: 'firstFrame', atMs: performance.now() });
      engine.emit({ attempt: 1, type: 'state', state: 'playing' });
      engine.emit({
        attempt: 1,
        type: 'clock',
        anchor: { positionMs: 61_000, atMs: performance.now(), rate: 1 },
      });
    });
    expect(screen.getByTestId('osd-clock')).toHaveTextContent('1:01');

    await advance(2_000);
    expect(screen.getByTestId('osd-clock')).toHaveTextContent('1:03');
    expect(raf.mock.calls.length).toBeGreaterThan(0);

    await act(async () => {
      engine.emit({ attempt: 1, type: 'state', state: 'ended' });
    });
    const callsAtEnd = raf.mock.calls.length;

    await advance(2_000);
    expect(raf.mock.calls.length).toBe(callsAtEnd);
    expect(screen.getByTestId('osd-clock')).toHaveTextContent('1:03');
    await view.unmount();
  });
});
