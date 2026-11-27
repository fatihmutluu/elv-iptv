import type { CatalogService } from '@elv/data';
import type { PlayTarget, VideoHost } from '@elv/features';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PopoutLaunchPayload, WindowBridge } from '../../../src/shared/window-ipc.ts';

interface EffectRecord {
  deps: readonly unknown[] | undefined;
  cleanup: (() => void) | undefined;
}

const hookState = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as Array<EffectRecord | undefined>,
  pendingEffects: [] as Array<{ index: number; create: () => (() => void) | undefined }>,
  reset() {
    this.cursor = 0;
    this.slots = [];
    this.effects = [];
    this.pendingEffects = [];
  },
  beginRender() {
    this.cursor = 0;
    this.pendingEffects = [];
  },
  flushEffects() {
    const queue = this.pendingEffects.splice(0);
    for (const item of queue) {
      const prev = this.effects[item.index];
      prev?.cleanup?.();
      const cleanup = item.create();
      const record = this.effects[item.index];
      if (record) record.cleanup = cleanup;
    }
  },
  unmount() {
    for (const rec of this.effects) rec?.cleanup?.();
    this.reset();
  },
}));

function depsChanged(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (!prev || !next || prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useRef<T>(initial: T) {
      const idx = hookState.cursor++;
      if (!hookState.slots[idx]) hookState.slots[idx] = { current: initial };
      return hookState.slots[idx] as { current: T };
    },
    useState<T>(initial: T | (() => T)) {
      const idx = hookState.cursor++;
      if (!(idx in hookState.slots)) {
        hookState.slots[idx] = typeof initial === 'function' ? (initial as () => T)() : initial;
      }
      const setState = (next: T | ((prev: T) => T)) => {
        hookState.slots[idx] =
          typeof next === 'function' ? (next as (prev: T) => T)(hookState.slots[idx] as T) : next;
      };
      return [hookState.slots[idx] as T, setState] as const;
    },
    useMemo<T>(factory: () => T, deps: readonly unknown[]) {
      const idx = hookState.cursor++;
      const prev = hookState.slots[idx] as { deps: readonly unknown[]; value: T } | undefined;
      if (!prev || depsChanged(prev.deps, deps)) {
        const value = factory();
        hookState.slots[idx] = { deps, value };
        return value;
      }
      return prev.value;
    },
    useCallback<T extends (...args: never[]) => unknown>(fn: T, deps: readonly unknown[]) {
      const idx = hookState.cursor++;
      const prev = hookState.slots[idx] as { deps: readonly unknown[]; value: T } | undefined;
      if (!prev || depsChanged(prev.deps, deps)) {
        hookState.slots[idx] = { deps, value: fn };
        return fn;
      }
      return prev.value;
    },
    useEffect(create: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const idx = hookState.cursor++;
      const prev = hookState.effects[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        hookState.effects[idx] = { deps, cleanup: prev?.cleanup };
        hookState.pendingEffects.push({ index: idx, create });
      }
    },
  };
});

vi.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
  StyleSheet: { create: <T>(s: T): T => s },
}));

const updatePreferences = vi.fn(async () => ({ ok: true as const, value: {} }));

vi.mock('@elv/features', () => ({
  AppProviders: 'AppProviders',
  DEFAULT_AUTO_HIDE_OSD_MS: 3_500,
  KeymapProvider: 'KeymapProvider',
  PlayerScreen: 'PlayerScreen',
  ProfileProvider: 'ProfileProvider',
  createLazyCatalog: () => ({}),
  noopPlaybackGuard: { acquire: () => ({ ok: true }), release: () => undefined },
  usePreferences: () => ({
    preferences: {
      playerVolume: 82,
      autoEnterPip: true,
      autoSubtitlesOnSkipBack: false,
      autoPlayNextEpisode: true,
      reduceMotion: false,
      bufferPreset: 'auto',
      useTextureView: false,
      seekStepSec: 10,
      defaultResizeMode: 'fit',
      preferredAudioLang: 'en',
      preferredSubtitleLang: 'en',
      preferredAudioLanguages: ['en'],
      preferredSubtitleLanguages: ['en'],
      preferDefaultAudioTrack: true,
      preferHevcOverDolbyVision: false,
      filterSdhSubtitles: false,
      subtitleMode: 'smart',
      subtitleFontFamily: 'system',
      subtitleStyle: { fontScale: 1 },
      tvClockMode: 'always',
      sleepTimerDefaultAction: 'stop',
      stillWatchingTimeoutMin: 0,
      preferredAudioDevice: 'auto',
      deinterlaceMode: 'auto',
      pitchLock: true,
      audioNormalization: false,
      windowAspectRatioLock: false,
      backgroundAudioPlayback: false,
      autoFrameRate: 'off',
      autoDynamicRange: false,
      nightModeDrc: 'off',
      audioDelayByRefreshRateMs: {},
      audioPassthrough: false,
      audioPassthroughCodecs: [],
      audioExclusive: false,
      audioAc3Encode: false,
      audioChannelLayout: 'auto',
      liveChannelSwitchMode: 'instant',
    },
    updatePreferences,
  }),
  useProfile: () => ({ activeProfileId: 'default' }),
}));

vi.mock('../ui/desktop-adapters.tsx', () => ({
  createDesktopUiAdapters: () => ({}),
}));

vi.mock('@elv/ui-kit', () => ({
  UiAdaptersProvider: 'UiAdaptersProvider',
  useTheme: () => ({
    colors: {
      bgCanvas: 'token-bgCanvas',
    },
  }),
}));

import { PopoutApp, PopoutPlayerStage, type PopoutPlayerStageProps } from './PopoutApp.tsx';

function findByType(node: unknown, typeName: string): ReactElement<Record<string, unknown>> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByType(child, typeName);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.type === typeName) return el;
  return findByType(el.props?.children, typeName);
}

function collectStyleColors(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectStyleColors(child, out);
    return out;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  const style = el.props?.style;
  const styles = Array.isArray(style) ? style : [style];
  for (const s of styles) {
    if (s && typeof s === 'object') {
      for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
        if (k.toLowerCase().includes('color') && typeof v === 'string') out.push(v);
      }
    }
  }
  collectStyleColors(el.props?.children, out);
  return out;
}

function renderStage(props: PopoutPlayerStageProps): ReactElement<Record<string, unknown>> {
  hookState.beginRender();
  const tree = PopoutPlayerStage(props) as ReactElement<Record<string, unknown>>;
  hookState.flushEffects();
  return tree;
}

describe('PopoutApp (Wave P3 full PlayerScreen + zero-reload handoff)', () => {
  beforeEach(() => {
    hookState.reset();
    updatePreferences.mockClear();
  });

  it('mounts full PlayerScreen with adoptEngineId, preferences, dock handoff with transferEngineId, and clean exit', async () => {
    const catalog = {} as unknown as CatalogService;
    const videoHost: VideoHost = {
      supportsMultiView: true,
      open: vi.fn(async () => null),
      adoptEngine: vi.fn(async () => null),
    };

    const initialPayload: PopoutLaunchPayload = {
      itemKey: 'movie:src1:m42',
      kind: 'movie',
      title: 'Night Screening',
      sourceId: 'src1',
      resumePositionMs: 10_000,
      transferEngineId: 'engine-9',
    };

    let pushPayload: ((next: PopoutLaunchPayload) => void) | undefined;
    const dockPopout = vi.fn(async () => undefined);
    const closePopout = vi.fn(async () => undefined);
    const windowBridge: WindowBridge = {
      setAlwaysOnTop: vi.fn(async (flag: boolean) => flag),
      getAlwaysOnTop: vi.fn(async () => false),
      onAlwaysOnTopChanged: () => () => undefined,
      setAspectRatioLock: vi.fn(async (f) => f),
      setMinimizeToTray: vi.fn(async (f) => f),
      openPopout: vi.fn(async () => true),
      closePopout,
      getPopoutPayload: vi.fn(async () => initialPayload),
      onPopoutPayload: (listener) => {
        pushPayload = listener;
        return () => undefined;
      },
      dockPopout,
      onPopoutDocked: () => () => undefined,
      onWindowRestored: () => () => undefined,
      onHiddenToTray: () => () => undefined,
    };

    const props: PopoutPlayerStageProps = { catalog, videoHost, windowBridge };
    const initialTree = renderStage(props);
    expect(findByType(initialTree, 'PlayerScreen')).toBeNull();
    expect(collectStyleColors(initialTree)).toEqual(['token-bgCanvas']);
    await Promise.resolve();
    await Promise.resolve();

    const tree = renderStage(props);
    const player = findByType(tree, 'PlayerScreen');
    if (!player) throw new Error('expected full PlayerScreen to mount');

    // Full player wiring + adoptEngineId + preferences
    expect(player.props.adoptEngineId).toBe('engine-9');
    expect(player.props.viewMode).toBe('full');
    expect(player.props.multiViewSupported).toBe(false);
    expect(player.props.initialVolume).toBe(82);
    expect(player.props.deinterlaceMode).toBe('auto');
    expect(player.props.pitchLock).toBe(true);
    expect(player.props.target).toEqual({
      itemKey: 'movie:src1:m42',
      sourceId: 'src1',
      title: 'Night Screening',
      kind: 'vod',
      itemKind: 'movie',
      startPositionMs: 10_000,
    });
    expect(player.props.onPopoutPlayer).toBeUndefined();
    expect(player.props.onEnterMultiView).toBeUndefined();
    expect(player.props.osdTimeDisplayMode).toBeUndefined();
    expect(player.props.onPersistOsdTimeDisplayMode).toBeUndefined();

    // Zapping inside Popout updates target in-place without changing session key
    const firstKey = player.key;
    const zappedTarget: PlayTarget = {
      itemKey: 'live:src1:ch5',
      sourceId: 'src1',
      title: 'Channel Five',
      kind: 'live',
      itemKind: 'live',
    };
    (player.props.onTargetChange as (t: PlayTarget) => void)(zappedTarget);
    const afterZap = renderStage(props);
    const playerAfterZap = findByType(afterZap, 'PlayerScreen');
    expect(playerAfterZap?.key).toBe(firstKey);
    expect(playerAfterZap?.props.target).toEqual(zappedTarget);

    // Pushing a new popout payload from main bumps session key and passes new transferEngineId
    pushPayload?.({
      itemKey: 'live:src1:ch9',
      kind: 'live',
      title: 'Channel Nine',
      sourceId: 'src1',
      transferEngineId: 'engine-12',
    });
    const afterPush = renderStage(props);
    const playerAfterPush = findByType(afterPush, 'PlayerScreen');
    expect(playerAfterPush?.key).not.toBe(firstKey);
    expect(playerAfterPush?.props.adoptEngineId).toBe('engine-12');

    // Docking back sends transferEngineId + current target to windowBridge.dockPopout
    const onDockPopout = playerAfterPush?.props.onDockPopout as (
      t: PlayTarget,
      posMs?: number,
      transferId?: string,
    ) => void;
    onDockPopout(zappedTarget, 42_000, 'engine-12');
    onDockPopout(zappedTarget, 42_000, 'engine-12'); // guarded against double-click
    expect(dockPopout).toHaveBeenCalledTimes(1);
    expect(dockPopout).toHaveBeenCalledWith({
      itemKey: 'live:src1:ch5',
      kind: 'live',
      title: 'Channel Five',
      sourceId: 'src1',
      transferEngineId: 'engine-12',
    });

    hookState.unmount();
  });

  it('closes popout window cleanly on PlayerScreen onExit and wraps PopoutApp in AppProviders + ProfileProvider', async () => {
    const closePopout = vi.fn(async () => undefined);
    const windowBridge: WindowBridge = {
      setAlwaysOnTop: vi.fn(async (flag: boolean) => flag),
      getAlwaysOnTop: vi.fn(async () => false),
      onAlwaysOnTopChanged: () => () => undefined,
      setAspectRatioLock: vi.fn(async (f) => f),
      setMinimizeToTray: vi.fn(async (f) => f),
      openPopout: vi.fn(async () => true),
      closePopout,
      getPopoutPayload: vi.fn(async () => ({
        itemKey: 'live:src1:ch1',
        kind: 'live' as const,
        title: 'News',
      })),
      onPopoutPayload: () => () => undefined,
      dockPopout: vi.fn(async () => undefined),
      onPopoutDocked: () => () => undefined,
      onWindowRestored: () => () => undefined,
      onHiddenToTray: () => () => undefined,
    };

    const props: PopoutPlayerStageProps = {
      catalog: {} as CatalogService,
      videoHost: { open: vi.fn(async () => null) },
      windowBridge,
    };
    renderStage(props);
    await Promise.resolve();
    await Promise.resolve();
    const tree = renderStage(props);
    const player = findByType(tree, 'PlayerScreen');
    if (!player) throw new Error('expected PlayerScreen');
    (player.props.onExit as () => void)();
    expect(closePopout).toHaveBeenCalledTimes(1);
    hookState.unmount();

    // Verify PopoutApp root provider hierarchy includes UiAdaptersProvider -> AppProviders -> ProfileProvider
    hookState.beginRender();
    const rootTree = PopoutApp() as ReactElement<Record<string, unknown>>;
    expect(findByType(rootTree, 'UiAdaptersProvider')).not.toBeNull();
    expect(findByType(rootTree, 'AppProviders')).not.toBeNull();
    expect(findByType(rootTree, 'ProfileProvider')).not.toBeNull();
  });
});
