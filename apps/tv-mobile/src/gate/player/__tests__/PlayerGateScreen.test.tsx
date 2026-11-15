import type { KeyInput } from '@elv/focus-core';
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

let mockOnInput: ((k: KeyInput) => void) | undefined;
jest.mock('@elv/ui-kit', () => ({
  ...jest.requireActual('@elv/ui-kit'),
  useTvKeySource: (onInput: (k: KeyInput) => void) => {
    mockOnInput = onInput;
  },
}));

let mockSurfaceMounts = 0;
jest.mock('@elv/engine-media3', () => ({
  createMedia3Engine: () => null,
  Media3Surface: () => {
    require('react').useEffect(() => {
      mockSurfaceMounts += 1;
    }, []);
    return null;
  },
}));

const HOST = 'http://10.0.2.2:7878/live/demo/demo';
const params: PlayerGateParams = {
  host: '10.0.2.2:7878',
  account: 'demo',
  channels: ['1001', '1002', '1003'],
  zaps: 3,
  rate: 1,
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

function playerLines(spy: jest.SpyInstance): string[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith('ELV_GATE_PLAYER '));
}

function onlyMetrics(spy: jest.SpyInstance) {
  const lines = playerLines(spy);
  if (lines.length !== 1) throw new Error(`expected one line, got ${lines.length}`);
  return JSON.parse((lines[0] ?? '').slice('ELV_GATE_PLAYER '.length));
}

const asEngine = (engine: PlayerEngine) => () => engine;

describe('PlayerGateScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, 'OS', 'android');
    mockSurfaceMounts = 0;
    mockOnInput = undefined;
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('keeps one OSD and one surface across zaps and prints exactly one line', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup();
    const cancelFrame = jest.spyOn(globalThis, 'cancelAnimationFrame');
    await render(<PlayerGateScreen params={params} createEngine={asEngine(engine)} />);
    const osd = screen.getByTestId('player-osd');
    expect(screen.getByTestId('osd-channel')).toHaveTextContent('Channel 1001');
    await act(async () => engine.surface('created'));
    await advance(1500);
    expect(screen.getByTestId('osd-channel')).toHaveTextContent('Channel 1002');
    expect(screen.getByTestId('osd-status')).toHaveTextContent('playing');
    await advance(4000);
    expect(screen.getByTestId('player-osd')).toBe(osd);
    expect(cancelFrame).not.toHaveBeenCalled();
    expect(mockSurfaceMounts).toBe(1);
    expect(playerLines(log)).toHaveLength(1);
    await advance(5000);
    expect(playerLines(log)).toHaveLength(1);
    const m = onlyMetrics(log);
    expect(m.zaps).toBe(3);
    expect(m.surfaceCreated).toBe(1);
    expect(m.staleEventsApplied).toBe(0);
    expect(m.failures).toBe(0);
    expect(m.fault).toBe('');
    expect(m.faultOutcome).toBeNull();
    expect(m.ttffColdMs).toBeGreaterThanOrEqual(300);
    expect(m.ttffColdMs).toBeLessThan(400);
    expect(m.ttffWarmMs.p50).toBeGreaterThanOrEqual(300);
    expect(m.zapMs.max).toBeGreaterThanOrEqual(300);
    expect(m.zapMs.max).toBeLessThan(400);
    expect(m.recoveries).toEqual({ '1': 0, '2': 0, '3': 0, '4': 0 });
    expect(engine.maxConcurrentMedias()).toBe(1);
    expect(screen.getByTestId('osd-channel')).toHaveTextContent('Channel 1001');
  });

  it('builds simulator URLs at play time', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup();
    await render(<PlayerGateScreen params={params} createEngine={asEngine(engine)} />);
    await advance(1100);
    const urls = engine.commands.filter((c) => c.name === 'load').map((c) => c.url);
    expect(urls).toEqual([`${HOST}/1001.ts`, `${HOST}/1002.ts`]);
  });

  it('drops stale engine events of an earlier tune without applying them', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup();
    await render(<PlayerGateScreen params={params} createEngine={asEngine(engine)} />);
    await advance(1100);
    await act(async () => {
      engine.emit({ attempt: 1, type: 'firstFrame', atMs: 1 });
      engine.emit({ attempt: 1, type: 'state', state: 'ended' });
    });
    await advance(8000);
    const m = onlyMetrics(log);
    expect(m.staleEventsDropped).toBe(2);
    expect(m.staleEventsApplied).toBe(0);
  });

  it('prints the line with console.error on iOS', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await render(
      <PlayerGateScreen params={{ ...params, zaps: 1 }} createEngine={asEngine(setup())} />,
    );
    await advance(5000);
    expect(playerLines(error)).toHaveLength(1);
    expect(playerLines(log)).toHaveLength(0);
  });

  it('zaps on channel up and down keys and counts them', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup();
    await render(
      <PlayerGateScreen
        params={{ ...params, zaps: 1, rate: 0.1 }}
        createEngine={asEngine(engine)}
      />,
    );
    await advance(1000);
    await act(async () => {
      mockOnInput?.({ key: 'channelDown', action: 'press', time: performance.now() });
    });
    expect(screen.getByTestId('osd-channel')).toHaveTextContent('Channel 1003');
    await advance(800);
    await act(async () => {
      mockOnInput?.({ key: 'channelUp', action: 'press', time: performance.now() });
    });
    expect(screen.getByTestId('osd-channel')).toHaveTextContent('Channel 1001');
    await act(async () => {
      mockOnInput?.({ key: 'select', action: 'press', time: performance.now() });
    });
    await advance(12_000);
    const m = onlyMetrics(log);
    expect(m.zaps).toBe(3);
    expect(m.zapMs.p50).not.toBeNull();
  });

  it('shows the recovery rung and judges a drop run recovered', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const dropUrl = `${HOST}/1001.ts?fault=drop@5s`;
    const engine = setup({
      [dropUrl]: [
        { afterMs: 300, emit: 'firstFrame' },
        { afterMs: 300, emit: 'state', state: 'playing' },
        { afterMs: 5000, emit: 'error', error: { code: 'network' } },
      ],
    });
    let engineRuns = 0;
    const base = engine.retry.bind(engine);
    engine.retry = (attempt) => {
      engineRuns += 1;
      base(attempt);
    };
    await render(
      <PlayerGateScreen
        params={{ ...params, zaps: 1, rate: 0.1, fault: 'drop5' }}
        createEngine={asEngine(engine)}
      />,
    );
    await advance(5100);
    expect(screen.getByTestId('osd-status')).toHaveTextContent('recovering (rung 1)');
    await advance(1500);
    expect(engineRuns).toBe(1);
    await advance(10_000);
    const m = onlyMetrics(log);
    expect(m.fault).toBe('drop5');
    expect(m.faultOutcome).toBe('recovered');
    expect(m.recoveries['1']).toBeGreaterThanOrEqual(1);
  });

  it('judges a drop run recovered when the engine resumes from a stall on its own', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup({
      [`${HOST}/1001.ts?fault=drop@5s`]: [
        { afterMs: 300, emit: 'firstFrame' },
        { afterMs: 300, emit: 'state', state: 'playing' },
        { afterMs: 5000, emit: 'stall', phase: 'start' },
        { afterMs: 6000, emit: 'state', state: 'playing' },
        { afterMs: 6000, emit: 'stall', phase: 'end' },
      ],
    });
    await render(
      <PlayerGateScreen
        params={{ ...params, zaps: 1, rate: 0.1, fault: 'drop5' }}
        createEngine={asEngine(engine)}
      />,
    );
    await advance(16_000);
    const m = onlyMetrics(log);
    expect(m.faultOutcome).toBe('recovered');
    expect(m.recoveries).toEqual({ '1': 0, '2': 0, '3': 0, '4': 0 });
  });

  it('ignores stalls of an older attempt', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup();
    await render(
      <PlayerGateScreen
        params={{ ...params, zaps: 1, rate: 0.1, fault: 'drop5' }}
        createEngine={asEngine(engine)}
      />,
    );
    await advance(1000);
    await act(async () => {
      engine.emit({ attempt: 0, type: 'stall', phase: 'start', atMs: 0 });
      engine.emit({ attempt: 0, type: 'stall', phase: 'end', atMs: 0 });
    });
    await advance(15_000);
    expect(onlyMetrics(log).faultOutcome).toBe('missed');
  });

  it('judges a 404 run failed-in-time and shows the error', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup({
      [`${HOST}/1001.ts?fault=status=404`]: [
        { afterMs: 100, emit: 'error', error: { code: 'http-404', httpStatus: 404 } },
      ],
    });
    await render(
      <PlayerGateScreen
        params={{ ...params, zaps: 1, rate: 0.2, fault: '404' }}
        createEngine={asEngine(engine)}
      />,
    );
    await advance(4000);
    expect(screen.getByTestId('osd-status')).toHaveTextContent('error: playback/http-404');
    await advance(8000);
    const m = onlyMetrics(log);
    expect(m.faultOutcome).toBe('failed-in-time');
    expect(m.failures).toBe(1);
  });

  it('judges a 509 run limited-backoff', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup({
      [`${HOST}/1001.ts?fault=status=509`]: [
        { afterMs: 100, emit: 'error', error: { code: 'http-509', httpStatus: 509 } },
      ],
    });
    await render(
      <PlayerGateScreen
        params={{ ...params, zaps: 1, rate: 0.5, fault: '509' }}
        createEngine={asEngine(engine)}
      />,
    );
    await advance(1000);
    expect(screen.getByTestId('osd-status')).toHaveTextContent('limited');
    await advance(8000);
    expect(onlyMetrics(log).faultOutcome).toBe('limited-backoff');
  });

  it('judges a silent fault run failed-in-time within a 20 s dwell (#81)', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup({
      [`${HOST}/1001.ts?fault=stall30s@0s`]: [],
    });
    await render(
      <PlayerGateScreen
        params={{ ...params, zaps: 1, rate: 0.05, fault: 'silent' }}
        createEngine={asEngine(engine)}
      />,
    );
    await advance(8500);
    expect(screen.getByTestId('osd-status')).toHaveTextContent('error: playback/network');
    await advance(13_000);
    const m = onlyMetrics(log);
    expect(m.fault).toBe('silent');
    expect(m.faultOutcome).toBe('failed-in-time');
    expect(m.failures).toBe(1);
    expect(m.recoveries).toEqual({ '1': 0, '2': 1, '3': 1, '4': 0 });
  });

  it('treats ended status as settled without waiting for the 15 s settle timeout', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const vodHost = 'http://10.0.2.2:7878/movie/demo/demo';
    const engine = setup({
      [`${vodHost}/200002.mp4`]: [{ afterMs: 200, emit: 'state', state: 'ended' }],
    });
    await render(
      <PlayerGateScreen
        params={{ ...params, channels: ['200001', '200002'], zaps: 1, rate: 1, stream: 'vod' }}
        createEngine={asEngine(engine)}
      />,
    );
    await advance(1500);
    expect(screen.getByTestId('osd-status')).toHaveTextContent('ended');
    expect(playerLines(log)).toHaveLength(1);
  });

  it('tunes the vod stream form as VOD', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup();
    const load = jest.spyOn(engine, 'load');
    await render(
      <PlayerGateScreen
        params={{ ...params, channels: ['200001'], zaps: 1, stream: 'vod' }}
        createEngine={asEngine(engine)}
      />,
    );
    await advance(100);
    expect(load.mock.calls[0]?.[0]).toMatchObject({
      kind: 'vod',
      url: 'http://10.0.2.2:7878/movie/demo/demo/200001.mp4',
    });
  });

  it('shows a clock that follows the engine position in its own frames', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup({
      [`${HOST}/1001.ts`]: [
        { afterMs: 100, emit: 'firstFrame' },
        { afterMs: 100, emit: 'state', state: 'playing' },
        { afterMs: 100, emit: 'clock', positionMs: 61_000 },
      ],
    });
    await render(
      <PlayerGateScreen
        params={{ ...params, zaps: 1, rate: 0.1 }}
        createEngine={asEngine(engine)}
      />,
    );
    expect(screen.getByTestId('osd-clock')).toHaveTextContent('--:--');
    await advance(400);
    expect(screen.getByTestId('osd-clock')).toHaveTextContent('1:01');
    await advance(2000);
    expect(screen.getByTestId('osd-clock')).toHaveTextContent('1:03');
  });

  it('says so and prints nothing when no engine exists', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await render(<PlayerGateScreen params={params} createEngine={() => null} />);
    await advance(5000);
    expect(screen.getByText('No player engine on this platform')).toBeOnTheScreen();
    expect(playerLines(log)).toHaveLength(0);
  });

  it('releases the engine and stops zapping when it unmounts', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup();
    const view = await render(<PlayerGateScreen params={params} createEngine={asEngine(engine)} />);
    await advance(500);
    await view.unmount();
    const loads = engine.commands.length;
    await advance(10_000);
    expect(engine.commands).toHaveLength(loads);
    expect(playerLines(log)).toHaveLength(0);
  });
});
