import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import {
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  THEME_PRESETS,
  type ThemePresetId,
  ThemeProvider,
  TvRemoteProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet, View } from 'react-native';
import type { PlayableEntry, PlayTarget } from '../../ports/play-target';
import { PlayerScreen } from '../PlayerScreen';
import {
  AUTOREPEAT_MS,
  COARSE_SEEK_MS,
  LONG_HOLD_MS,
  SCRUB_SETTLE_MS,
  STEP_SEEK_MS,
} from '../scrub-controller';
import { createFakeAndroidKeys, createManualClock } from './player-test-harness';

const KEY_BACK = 4;
const KEY_0 = 7;
const KEY_5 = 12;
const KEY_9 = 16;
const KEY_UP = 19;
const KEY_DOWN = 20;
const KEY_LEFT = 21;
const KEY_RIGHT = 22;
const KEY_SELECT = 23;
const KEY_CH_UP = 166;

const SAMPLE_TRACKS: MediaTracks = {
  audio: [{ id: 'a:1', language: 'eng', label: 'English', codec: 'aac', channels: 2 }],
  subtitles: [{ id: 's:1', language: 'eng', codec: 'subrip' }],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

const VOD_TARGET: PlayTarget = {
  itemKey: 'x:src-1:vod:900',
  sourceId: 'src-1',
  title: 'Ergonomics Film',
  kind: 'vod',
};

const LIVE_ENTRIES: readonly PlayableEntry[] = [
  { itemKey: 'ch:0', sourceId: 'src-1', title: '1. Channel One', kind: 'live' },
  { itemKey: 'ch:1', sourceId: 'src-1', title: '2. Channel Two', kind: 'live' },
];

function flatStyle(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style);
}

async function mountTvPlayer(opts: {
  target?: PlayTarget;
  preset?: ThemePresetId;
  initialOsdHidden?: boolean;
  autoHideOsdMs?: number;
  withTracks?: boolean;
}) {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

  const keys = createFakeAndroidKeys();
  const manual = createManualClock();
  const engine = createFakePlayerEngine({
    now: manual.now,
    schedule: manual.schedule,
    cancel: manual.cancel,
  });
  const onExit = jest.fn();
  const catalog = {
    resolveStream: jest.fn(async (k: string) =>
      ok({ url: `http://sim.example.test/${k}.mkv`, headers: {} }),
    ),
  };
  const target = opts.target ?? VOD_TARGET;

  const renderTree = (nextTarget: PlayTarget) => (
    <ThemeProvider preset={opts.preset ?? 'obsidianCrimson'}>
      <RemoteKeysProvider android={keys.source}>
        <FormFactorProvider value="tv">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={catalog}
              videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
              target={nextTarget}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              initialOsdHidden={opts.initialOsdHidden}
              autoHideOsdMs={opts.autoHideOsdMs}
              onExit={onExit}
            />
          </I18nProvider>
        </FormFactorProvider>
      </RemoteKeysProvider>
    </ThemeProvider>
  );

  const view = await render(renderTree(target));

  await waitFor(() => {
    expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
  });
  await act(async () => {
    manual.advance(350);
  });
  const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
  await act(async () => {
    if (target.kind === 'vod') {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 40_000, atMs: manual.now(), rate: 0, durationMs: 200_000 },
      });
    }
    if (opts.withTracks) {
      engine.emit({ attempt, type: 'tracks', tracks: SAMPLE_TRACKS });
    }
  });

  return {
    view,
    keys,
    manual,
    engine,
    onExit,
    catalog,
    attempt,
    rerenderTarget: (next: PlayTarget) => view.rerender(renderTree(next)),
  };
}

describe('Player ergonomics (#296, #297, #212)', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('#296: seeks VOD to 0%/50%/90% on TV digit keys and ignores digits on Live', async () => {
    const tvVod = await mountTvPlayer({});

    await act(async () => tvVod.keys.tap(KEY_5));
    expect(tvVod.engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(100_000);

    await act(async () => tvVod.keys.tap(KEY_9));
    expect(tvVod.engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(180_000);

    await act(async () => tvVod.keys.tap(KEY_0));
    expect(tvVod.engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(0);

    await tvVod.view.unmount();

    const tvLive = await mountTvPlayer({
      target: {
        ...(LIVE_ENTRIES[0] as PlayableEntry),
        playlist: {
          count: 2,
          currentIndex: 0,
          onChangeIndex: jest.fn(),
          getAt: async (i) => LIVE_ENTRIES[i],
        },
      },
    });

    await act(async () => tvLive.keys.tap(KEY_5));
    expect(tvLive.engine.commands.some((c) => c.name === 'seek')).toBe(false);
    await tvLive.view.unmount();
  });

  it('#296: hides TV OSD via Up or autoHideOsdMs and consumes first wake keypress without blind pause/seek while Back exits and Live CH+ zaps', async () => {
    const tvVod = await mountTvPlayer({ autoHideOsdMs: 4_000 });
    expect(screen.getByTestId('player-osd')).toBeTruthy();

    // Up on unfocused TV VOD hides OSD cleanly while preserving anchor + video surface
    await act(async () => tvVod.keys.tap(KEY_UP));
    expect(screen.queryByTestId('player-osd')).toBeNull();
    expect(
      screen.getByTestId('player-tv-focus-anchor', { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(screen.getByTestId('player-surface-layer')).toBeTruthy();

    // First keypress (Select) wakes OSD ONLY — never pauses!
    await act(async () => tvVod.keys.tap(KEY_SELECT));
    expect(screen.getByTestId('player-osd')).toBeTruthy();
    expect(tvVod.engine.commands.some((c) => c.name === 'pause')).toBe(false);

    // Auto-hide hides OSD after autoHideOsdMs
    await act(async () => {
      tvVod.manual.advance(3_999);
    });
    expect(screen.getByTestId('player-osd')).toBeTruthy();
    await act(async () => {
      tvVod.manual.advance(1);
    });
    expect(screen.queryByTestId('player-osd')).toBeNull();

    // First keypress (Left) while hidden wakes OSD ONLY — never seeks!
    await act(async () => tvVod.keys.tap(KEY_LEFT));
    expect(screen.getByTestId('player-osd')).toBeTruthy();
    expect(tvVod.engine.commands.some((c) => c.name === 'seek')).toBe(false);

    // Hide again, then Back exits immediately without requiring a second press
    await act(async () => tvVod.keys.tap(KEY_UP));
    expect(screen.queryByTestId('player-osd')).toBeNull();
    await act(async () => tvVod.keys.tap(KEY_BACK));
    expect(tvVod.onExit).toHaveBeenCalledTimes(1);

    await tvVod.view.unmount();

    // Live TV with hidden OSD: CH+ still zaps immediately and wakes OSD on itemKey change
    const tvLive = await mountTvPlayer({
      initialOsdHidden: true,
      target: {
        ...(LIVE_ENTRIES[0] as PlayableEntry),
        playlist: {
          count: 2,
          currentIndex: 0,
          onChangeIndex: jest.fn(),
          getAt: async (i) => LIVE_ENTRIES[i],
        },
      },
    });
    expect(screen.queryByTestId('player-osd')).toBeNull();

    await act(async () => tvLive.keys.tap(KEY_CH_UP));
    await waitFor(() => {
      expect(tvLive.catalog.resolveStream).toHaveBeenLastCalledWith('ch:1');
    });
    expect(screen.getByTestId('player-osd')).toBeTruthy();
    expect(screen.getByTestId('osd-title')).toHaveTextContent('2. Channel Two');

    await tvLive.view.unmount();
  });

  it.each(['obsidianCrimson', 'highContrast'] as const)(
    '#297: focuses VodProgressBar on TV Down->Up (%s), traps Left/Right scrub, returns on Down, and blurs on Back without exiting',
    async (preset) => {
      const tv = await mountTvPlayer({ preset, withTracks: true });
      expect(screen.queryByTestId('player-progress-focus-ring')).toBeNull();
      expect(flatStyle('player-progress-thumb')?.width).toBe(16);

      // Down enters OSD action bar -> Up moves focus to VodProgressBar scrubber
      await act(async () => tv.keys.tap(KEY_DOWN));
      await act(async () => tv.keys.tap(KEY_UP));

      const ringStyle = flatStyle('player-progress-focus-ring');
      expect(ringStyle?.borderColor).toBe(THEME_PRESETS[preset].focusRingColor);
      expect(flatStyle('player-progress-thumb')).toMatchObject({
        width: 20,
        height: 20,
        borderWidth: 2,
        borderColor: THEME_PRESETS[preset].bgCanvas,
      });

      // Left/Right traps horizontally into scrub preview and commits on key-up (never jumps to OSD buttons)
      await act(async () => tv.keys.down(KEY_RIGHT));
      expect(screen.getByTestId('player-progress-time-current')).toHaveTextContent('0:50');
      expect(screen.getByTestId('player-progress-time')).toHaveTextContent('2:30');
      expect(tv.engine.commands.some((c) => c.name === 'seek')).toBe(false);
      await act(async () => tv.keys.up(KEY_RIGHT));
      expect(tv.engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(50_000);
      expect(screen.getByTestId('player-progress-focus-ring')).toBeTruthy();

      // Down exits scrubber back to OSD action bar
      await act(async () => tv.keys.tap(KEY_DOWN));
      expect(screen.queryByTestId('player-progress-focus-ring')).toBeNull();

      // Up back into scrubber -> Back clears scrubber focus WITHOUT calling onExit
      await act(async () => tv.keys.tap(KEY_UP));
      expect(screen.getByTestId('player-progress-focus-ring')).toBeTruthy();
      await act(async () => tv.keys.tap(KEY_BACK));
      expect(screen.queryByTestId('player-progress-focus-ring')).toBeNull();
      expect(tv.onExit).not.toHaveBeenCalled();

      await tv.view.unmount();
    },
  );

  it('#212: supports Desktop VOD shortcuts (0-9, Home, End, Shift+Arrow, J/K/L), ignores editable targets, and rate-limits held repeats', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <FormFactorProvider value="desktop">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={{
                resolveStream: async () =>
                  ok({ url: 'http://sim.example.test/vod.mkv', headers: {} }),
              }}
              videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
              target={VOD_TARGET}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </FormFactorProvider>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    await act(async () => {
      manual.advance(350);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      engine.emit({
        attempt,
        type: 'clock',
        anchor: { positionMs: 60_000, atMs: manual.now(), rate: 0, durationMs: 200_000 },
      });
    });

    const onKeyDown = screen.getByTestId('player-screen').props.onKeyDown as (e: {
      key: string;
      shiftKey?: boolean;
      ctrlKey?: boolean;
      repeat?: boolean;
      target?: unknown;
      preventDefault?: () => void;
    }) => void;
    const onKeyUp = screen.getByTestId('player-screen').props.onKeyUp as (e: {
      key: string;
    }) => void;

    // 0-9 percentage jumps
    await act(async () => onKeyDown({ key: '5', preventDefault: jest.fn() }));
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(100_000);

    // Home -> 0ms, End -> durationMs - 10s (190_000ms)
    await act(async () => onKeyDown({ key: 'Home', preventDefault: jest.fn() }));
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(0);
    await act(async () => onKeyDown({ key: 'End', preventDefault: jest.fn() }));
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(
      200_000 - STEP_SEEK_MS,
    );

    // Shift+ArrowLeft (-30s) & Shift+ArrowRight (+30s)
    await act(async () =>
      onKeyDown({ key: 'ArrowLeft', shiftKey: true, preventDefault: jest.fn() }),
    );
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(
      190_000 - COARSE_SEEK_MS,
    );
    await act(async () =>
      onKeyDown({ key: 'ArrowRight', shiftKey: true, preventDefault: jest.fn() }),
    );
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(190_000);
    await act(async () => onKeyUp({ key: 'ArrowRight' }));

    // J (-10s), L (+10s), K (Play/Pause)
    await act(async () => onKeyDown({ key: 'j', preventDefault: jest.fn() }));
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(180_000);
    await act(async () => onKeyDown({ key: 'L', preventDefault: jest.fn() }));
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(190_000);
    await act(async () => onKeyDown({ key: 'k', preventDefault: jest.fn() }));
    expect(engine.commands.filter((c) => c.name === 'pause')).toHaveLength(1);

    // Ignored when target is editable or Ctrl modifier is held
    const seeksBefore = engine.commands.filter((c) => c.name === 'seek').length;
    await act(async () =>
      onKeyDown({ key: 'j', target: { tagName: 'INPUT' }, preventDefault: jest.fn() }),
    );
    await act(async () => onKeyDown({ key: 'l', ctrlKey: true, preventDefault: jest.fn() }));
    expect(engine.commands.filter((c) => c.name === 'seek')).toHaveLength(seeksBefore);

    // Held repeat burst on 'j' is throttled by LONG_HOLD_MS (350ms) and AUTOREPEAT_MS (160ms)
    await act(async () => onKeyUp({ key: 'j' }));
    const countBeforeBurst = engine.commands.filter((c) => c.name === 'seek').length;
    await act(async () => onKeyDown({ key: 'j', preventDefault: jest.fn() }));
    expect(engine.commands.filter((c) => c.name === 'seek')).toHaveLength(countBeforeBurst + 1);

    // Flood 5 repeats within 200ms -> all dropped!
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        manual.advance(40);
        onKeyDown({ key: 'j', repeat: true, preventDefault: jest.fn() });
      });
    }
    expect(engine.commands.filter((c) => c.name === 'seek')).toHaveLength(countBeforeBurst + 1);

    // Advance to LONG_HOLD_MS (350ms total) -> 1 repeat allowed!
    await act(async () => {
      manual.advance(LONG_HOLD_MS - 200);
      onKeyDown({ key: 'j', repeat: true, preventDefault: jest.fn() });
    });
    expect(engine.commands.filter((c) => c.name === 'seek')).toHaveLength(countBeforeBurst + 2);

    // Rapid repeat before AUTOREPEAT_MS -> dropped; at AUTOREPEAT_MS -> allowed!
    await act(async () => {
      manual.advance(AUTOREPEAT_MS - 1);
      onKeyDown({ key: 'j', repeat: true, preventDefault: jest.fn() });
    });
    expect(engine.commands.filter((c) => c.name === 'seek')).toHaveLength(countBeforeBurst + 2);
    await act(async () => {
      manual.advance(1);
      onKeyDown({ key: 'j', repeat: true, preventDefault: jest.fn() });
    });
    expect(engine.commands.filter((c) => c.name === 'seek')).toHaveLength(countBeforeBurst + 3);

    await view.unmount();
  });

  it('#212: supports standardized VOD shortcuts on web Electron window keydown without double-firing digits', async () => {
    jest.replaceProperty(Platform, 'OS', 'web' as typeof Platform.OS);
    const listeners = new Map<string, Set<(e?: unknown) => void>>();
    const win = {
      document: { activeElement: null },
      addEventListener: (type: string, fn: (e?: unknown) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (e?: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      },
    };
    const globals = globalThis as unknown as { window?: unknown; document?: unknown };
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    globals.window = win;
    globals.document = win.document;

    try {
      const manual = createManualClock();
      const engine = createFakePlayerEngine({
        now: manual.now,
        schedule: manual.schedule,
        cancel: manual.cancel,
      });

      const view = await render(
        <ThemeProvider preset="obsidianCrimson">
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: async () =>
                    ok({ url: 'http://sim.example.test/vod.mkv', headers: {} }),
                }}
                videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
                target={VOD_TARGET}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </ThemeProvider>,
      );

      await waitFor(() => {
        expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
      });
      await act(async () => {
        manual.advance(350);
      });
      const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
      await act(async () => {
        engine.emit({
          attempt,
          type: 'clock',
          anchor: { positionMs: 60_000, atMs: manual.now(), rate: 0, durationMs: 200_000 },
        });
      });

      const emitKey = async (type: 'keydown' | 'keyup', e: Record<string, unknown>) => {
        await act(async () => {
          for (const fn of listeners.get(type) ?? []) fn({ preventDefault: jest.fn(), ...e });
        });
      };

      // Digit '5' seeks ONCE (never double-fired between subscribeWebKeys and useDesktopPlayerShortcuts)
      await emitKey('keydown', { key: '5' });
      await emitKey('keyup', { key: '5' });
      expect(engine.commands.filter((c) => c.name === 'seek')).toHaveLength(1);
      expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(100_000);

      // Shift+ArrowLeft seeks -30s cleanly without leaving a stray scrub preview
      await emitKey('keydown', { key: 'ArrowLeft', shiftKey: true });
      await emitKey('keyup', { key: 'ArrowLeft' });
      expect(engine.commands.filter((c) => c.name === 'seek')).toHaveLength(2);
      expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(70_000);

      // Home / End / J / K / L
      await emitKey('keydown', { key: 'Home' });
      expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(0);
      await emitKey('keydown', { key: 'End' });
      expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(190_000);
      await emitKey('keydown', { key: 'j' });
      expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(180_000);
      await emitKey('keydown', { key: 'l' });
      expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(190_000);
      await emitKey('keydown', { key: 'k' });
      expect(engine.commands.filter((c) => c.name === 'pause')).toHaveLength(1);

      // Ignored inside an <input> or during IME composition
      const seeksBefore = engine.commands.filter((c) => c.name === 'seek').length;
      await emitKey('keydown', { key: '5', target: { tagName: 'INPUT' } });
      await emitKey('keydown', { key: 'j', target: { tagName: 'TEXTAREA' } });
      await emitKey('keydown', { key: 'j', isComposing: true });
      expect(engine.commands.filter((c) => c.name === 'seek')).toHaveLength(seeksBefore);

      // End on a short <= 10s clip seeks to durationMs (not 0)
      const latestAttempt = engine.commands.at(-1)?.attempt ?? attempt;
      await act(async () => {
        engine.emit({
          attempt: latestAttempt,
          type: 'clock',
          anchor: { positionMs: 2_000, atMs: manual.now(), rate: 0, durationMs: 8_000 },
        });
      });
      await emitKey('keydown', { key: 'End' });
      expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(8_000);

      await view.unmount();
    } finally {
      globals.window = prevWindow;
      globals.document = prevDocument;
    }
  });

  it('#212 review #1: web TvRemoteProvider + Shift+ArrowRight held with Shift released first never triggers scrub.step/commit', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.replaceProperty(Platform, 'OS', 'web' as typeof Platform.OS);
    const listeners = new Map<string, Set<(e?: unknown) => void>>();
    const win = {
      document: { activeElement: null },
      addEventListener: (type: string, fn: (e?: unknown) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (e?: unknown) => void) => {
        listeners.get(type)?.delete(fn);
      },
    };
    const globals = globalThis as unknown as { window?: unknown; document?: unknown };
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    globals.window = win;
    globals.document = win.document;

    try {
      const manual = createManualClock();
      const engine = createFakePlayerEngine({
        now: manual.now,
        schedule: manual.schedule,
        cancel: manual.cancel,
      });

      const view = await render(
        <ThemeProvider preset="obsidianCrimson">
          <TvRemoteProvider>
            <FormFactorProvider value="desktop">
              <I18nProvider i18n={createAppI18n('en')}>
                <PlayerScreen
                  catalog={{
                    resolveStream: async () =>
                      ok({ url: 'http://sim.example.test/vod.mkv', headers: {} }),
                  }}
                  videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
                  target={VOD_TARGET}
                  clock={{ now: manual.now }}
                  timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                  onExit={jest.fn()}
                />
              </I18nProvider>
            </FormFactorProvider>
          </TvRemoteProvider>
        </ThemeProvider>,
      );

      await waitFor(() => {
        expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
      });
      await act(async () => manual.advance(350));
      const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
      await act(async () => {
        engine.emit({
          attempt,
          type: 'clock',
          anchor: { positionMs: 50_000, atMs: manual.now(), rate: 0, durationMs: 200_000 },
        });
      });

      const emitKey = async (type: 'keydown' | 'keyup', e: Record<string, unknown>) => {
        await act(async () => {
          for (const fn of listeners.get(type) ?? []) fn({ preventDefault: jest.fn(), ...e });
        });
      };

      // Hold Shift+ArrowRight past LONG_PRESS_MS, then release Shift BEFORE releasing ArrowRight
      await emitKey('keydown', { key: 'ArrowRight', shiftKey: true });
      expect(engine.commands.filter((c) => c.name === 'seek').map((c) => c.positionMs)).toEqual([
        80_000,
      ]);

      await act(async () => {
        jest.advanceTimersByTime(650);
      });
      await emitKey('keyup', { key: 'Shift' });
      await emitKey('keyup', { key: 'ArrowRight', shiftKey: false });
      await act(async () => {
        manual.advance(SCRUB_SETTLE_MS + 50);
      });

      // Must remain a single +30s seek — ZERO spurious scrub.step / scrub.commit seeks!
      expect(engine.commands.filter((c) => c.name === 'seek').map((c) => c.positionMs)).toEqual([
        80_000,
      ]);

      await view.unmount();
    } finally {
      globals.window = prevWindow;
      globals.document = prevDocument;
    }
  });

  it('#296/#297 review #2, #3, #5: suppresses autoHide while scrubbing, cancels scrub on hideOsd, clears scrubber on VOD->Live, and avoids dual retry focus', async () => {
    const tv = await mountTvPlayer({ autoHideOsdMs: 500, withTracks: true });

    // Start scrub preview (key down without release) -> autoHideOsdMs (500ms) must NOT hide OSD while scrubbing
    await act(async () => tv.keys.down(KEY_RIGHT));
    expect(screen.getByTestId('player-progress-time-current')).toHaveTextContent('0:50');
    expect(screen.getByTestId('player-progress-time')).toHaveTextContent('2:30');
    await act(async () => tv.manual.advance(600));
    expect(screen.getByTestId('player-osd')).toBeTruthy();

    // Pressing Up hides OSD AND cancels pending scrub settle timer (zero delayed seeks!)
    await act(async () => tv.keys.tap(KEY_UP));
    expect(screen.queryByTestId('player-osd')).toBeNull();
    await act(async () => tv.keys.up(KEY_RIGHT));
    await act(async () => tv.manual.advance(SCRUB_SETTLE_MS + 50));
    expect(tv.engine.commands.some((c) => c.name === 'seek')).toBe(false);

    // Wake OSD, emit non-recoverable auth error so Retry mounts, focus scrubber -> no dual focus ring on Retry
    await act(async () => tv.keys.tap(KEY_SELECT));
    await act(async () => {
      tv.engine.emit({ attempt: tv.attempt, type: 'error', error: { code: 'http-401' } });
    });
    expect(screen.getByTestId('player-retry').props.accessibilityState).toEqual({ selected: true });
    await act(async () => tv.keys.tap(KEY_DOWN));
    await act(async () => tv.keys.tap(KEY_UP));
    expect(screen.getByTestId('player-progress-focus-ring')).toBeTruthy();
    expect(screen.getByTestId('player-retry').props.accessibilityState).toEqual({
      selected: false,
    });

    // Switch VOD -> Live with same itemKey: scrubber focus clears immediately so Up zaps instead of trapping
    const onChangeIndex = jest.fn();
    await tv.rerenderTarget({
      itemKey: VOD_TARGET.itemKey,
      sourceId: 'src-1',
      title: 'Live Switch',
      kind: 'live',
      playlist: {
        count: 2,
        currentIndex: 0,
        onChangeIndex,
        getAt: async (i) => LIVE_ENTRIES[i],
      },
    });
    await act(async () => tv.keys.tap(KEY_UP));
    await waitFor(() => {
      expect(onChangeIndex).toHaveBeenCalledWith(1);
    });

    await tv.view.unmount();
  });

  it('#139: suppresses synthetic post-tap mouse/pointer hover on mobile/tablet so OSD auto-hide completes cleanly', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <FormFactorProvider value="tablet">
          <I18nProvider i18n={createAppI18n('en')}>
            <PlayerScreen
              catalog={{
                resolveStream: async () =>
                  ok({ url: 'http://sim.example.test/vod.mkv', headers: {} }),
              }}
              videoHost={{ open: () => ({ engine, renderSurface: () => <View /> }) }}
              target={VOD_TARGET}
              clock={{ now: manual.now }}
              timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
              autoHideOsdMs={2_000}
              onExit={jest.fn()}
            />
          </I18nProvider>
        </FormFactorProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));
    await act(async () => manual.advance(350));
    expect(screen.getByTestId('player-osd')).toBeTruthy();

    // Tap at +1500ms, then synthetic mouseMove + pointerMove(touch) within 500ms must NOT reset auto-hide
    await act(async () => manual.advance(1_500));
    const root = screen.getByTestId('player-screen');
    await fireEvent(root, 'touchStart');
    await act(async () => manual.advance(100));
    await fireEvent(root, 'mouseMove');
    await fireEvent(root, 'pointerMove', { nativeEvent: { pointerType: 'touch' } });

    // Remaining 400ms elapses -> OSD auto-hides right on schedule!
    await act(async () => manual.advance(400));
    expect(screen.queryByTestId('player-osd')).toBeNull();

    // Another synthetic mouseMove within 500ms of touch does NOT wake hidden OSD
    await fireEvent(root, 'touchStart');
    await act(async () => manual.advance(499));
    await fireEvent(root, 'mouseMove');
    expect(screen.queryByTestId('player-osd')).toBeNull();

    // Genuine mouse hover after 500ms DOES wake OSD
    await act(async () => manual.advance(1));
    await fireEvent(root, 'pointerMove', { nativeEvent: { pointerType: 'mouse' } });
    expect(screen.getByTestId('player-osd')).toBeTruthy();

    await view.unmount();
  });
});
