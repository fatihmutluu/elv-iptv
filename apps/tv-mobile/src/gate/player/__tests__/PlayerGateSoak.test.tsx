import {
  createFakePlayerEngine,
  type FakePlayerEngine,
  type FakeStep,
} from '@elv/playback/testing';
import { render } from '@testing-library/react-native';
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

const LIVE = 'http://10.0.2.2:7878/live/demo/demo';
const VOD = 'http://10.0.2.2:7878/movie/demo/demo';
const params: PlayerGateParams = {
  host: '10.0.2.2:7878',
  account: 'demo',
  channels: ['1001', '1002', '1003'],
  zaps: 3,
  rate: 1,
  fault: '',
  stream: 'ts',
  soak: 1,
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

const loads = (engine: FakePlayerEngine) =>
  engine.commands.filter((c) => c.name === 'load').map((c) => c.url);

describe('PlayerGateScreen soak runs', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, 'OS', 'android');
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a soak run prints after its hold', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup({
      [`${LIVE}/1001.ts`]: [
        { afterMs: 300, emit: 'firstFrame' },
        { afterMs: 300, emit: 'state', state: 'playing' },
        { afterMs: 300, emit: 'clock', positionMs: 0 },
      ],
    });
    await render(<PlayerGateScreen params={params} createEngine={() => engine} />);
    await advance(59_000, 500);
    expect(playerLines(log)).toHaveLength(0);
    await advance(1000, 500);
    expect(playerLines(log)).toHaveLength(1);
    await advance(30_000, 1000);
    const m = onlyMetrics(log);
    expect(loads(engine)).toEqual([`${LIVE}/1001.ts`]);
    expect(m.zaps).toBe(0);
    expect(m.final).toBe('playing');
    expect(m.soak).toMatchObject({ minutes: 1, stalls: 0, ended: false, durationMs: null });
    expect(m.soak.playedMs).toBeGreaterThan(59_000);
    expect(m.soak.playedMs).toBeLessThanOrEqual(60_000);
    expect(Math.abs(m.soak.playedMs - m.soak.positionAdvancedMs)).toBeLessThan(50);
  });

  it('a VOD soak prints when the movie ends', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup({
      [`${VOD}/200001.mp4`]: [
        { afterMs: 300, emit: 'firstFrame' },
        { afterMs: 300, emit: 'state', state: 'playing' },
        { afterMs: 300, emit: 'clock', positionMs: 0 },
        { afterMs: 5300, emit: 'state', state: 'ended' },
      ],
    });
    await render(
      <PlayerGateScreen
        params={{ ...params, channels: ['200001', '200002'], stream: 'vod', soak: 2 }}
        createEngine={() => engine}
      />,
    );
    await advance(5000, 100);
    expect(playerLines(log)).toHaveLength(0);
    await advance(500, 100);
    expect(playerLines(log)).toHaveLength(1);
    await advance(150_000, 1000);
    const m = onlyMetrics(log);
    expect(loads(engine)).toEqual([`${VOD}/200001.mp4`]);
    expect(m.zaps).toBe(0);
    expect(m.final).toBe('other');
    expect(m.soak).toMatchObject({ minutes: 2, ended: true });
    expect(m.soak.positionAdvancedMs).toBeGreaterThan(4900);
  });

  it('a VOD soak that never ends prints after its hold', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await render(
      <PlayerGateScreen
        params={{ ...params, channels: ['200001'], stream: 'vod' }}
        createEngine={() => setup()}
      />,
    );
    await advance(59_000, 500);
    expect(playerLines(log)).toHaveLength(0);
    await advance(1000, 500);
    expect(onlyMetrics(log).soak).toMatchObject({ minutes: 1, ended: false });
  });

  it('a soak run prints a failure at once', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const engine = setup({
      [`${LIVE}/1001.ts?fault=status=404`]: [
        { afterMs: 100, emit: 'error', error: { code: 'http-404', httpStatus: 404 } },
      ],
    });
    await render(
      <PlayerGateScreen params={{ ...params, fault: '404' }} createEngine={() => engine} />,
    );
    await advance(10_000, 100);
    const m = onlyMetrics(log);
    expect(m.final).toBe('failed');
    expect(m.zaps).toBe(0);
    expect(m.soak).toMatchObject({ minutes: 1, playedMs: 0, positionAdvancedMs: 0 });
  });
});
