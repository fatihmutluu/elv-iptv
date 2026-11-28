import type { CatalogService } from '@elv/data';
import { elvError, err, ok } from '@elv/domain';
import type { PlaybackGuard, VideoHost } from '@elv/features';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc.ts';
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

const profileMock = vi.hoisted(() => ({
  activeProfileId: 'default',
  parentalUnlocked: true,
  parentalLoadError: false,
  lockParentalNow: vi.fn(),
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

vi.mock('@elv/features', async () => {
  const { createProfileScopedCatalog } = await import(
    '../../../../../packages/features/src/shared/profile-scoped-catalog.ts'
  );
  const { SESSION_GUARD_CHANNEL, SESSION_GUARD_STORAGE_KEY } = await import(
    '../../../../../packages/features/src/shared/session-guard-channel.ts'
  );
  return {
    AppProviders: 'AppProviders',
    DEFAULT_AUTO_HIDE_OSD_MS: 3_500,
    KeymapProvider: 'KeymapProvider',
    PlayerScreen: 'PlayerScreen',
    ProfileProvider: 'ProfileProvider',
    SESSION_GUARD_CHANNEL,
    SESSION_GUARD_STORAGE_KEY,
    createLazyCatalog: () => ({}),
    createProfileScopedCatalog,
    usePreferences: () => ({
      preferences: {
        playerVolume: 80,
        autoEnterPip: true,
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
      updatePreferences: vi.fn(async () => ({ ok: true as const, value: {} })),
    }),
    useProfile: () => profileMock,
  };
});

vi.mock('../ui/desktop-adapters.tsx', () => ({
  createDesktopUiAdapters: () => ({}),
}));

vi.mock('@elv/ui-kit', () => ({
  UiAdaptersProvider: 'UiAdaptersProvider',
  useTheme: () => ({ colors: { bgCanvas: 'token-bgCanvas' } }),
}));

import { PopoutPlayerStage, type PopoutPlayerStageProps } from './PopoutApp.tsx';

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly listeners = new Set<(event: { data: unknown }) => void>();
  constructor(readonly name: string) {
    let set = FakeBroadcastChannel.channels.get(name);
    if (!set) {
      set = new Set();
      FakeBroadcastChannel.channels.set(name, set);
    }
    set.add(this);
  }
  postMessage(data: unknown): void {
    const peers = FakeBroadcastChannel.channels.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer === this) continue;
      peer.onmessage?.({ data });
      for (const fn of peer.listeners) fn({ data });
    }
  }
  addEventListener(_type: string, fn: (event: { data: unknown }) => void): void {
    this.listeners.add(fn);
  }
  removeEventListener(_type: string, fn: (event: { data: unknown }) => void): void {
    this.listeners.delete(fn);
  }
  close(): void {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

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

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

function renderStage(props: PopoutPlayerStageProps): ReactElement<Record<string, unknown>> {
  hookState.beginRender();
  const tree = PopoutPlayerStage(props) as ReactElement<Record<string, unknown>>;
  hookState.flushEffects();
  return tree;
}

function makeWindowBridge(
  initial: PopoutLaunchPayload,
  closePopout: () => Promise<void>,
): WindowBridge {
  return {
    setAlwaysOnTop: vi.fn(async (flag: boolean) => flag),
    getAlwaysOnTop: vi.fn(async () => false),
    onAlwaysOnTopChanged: () => () => undefined,
    setAspectRatioLock: vi.fn(async (f) => f),
    setMinimizeToTray: vi.fn(async (f) => f),
    openPopout: vi.fn(async () => true),
    closePopout,
    getPopoutPayload: vi.fn(async () => initial),
    onPopoutPayload: () => () => undefined,
    dockPopout: vi.fn(async () => undefined),
    onPopoutDocked: () => () => undefined,
    onWindowRestored: () => () => undefined,
    onHiddenToTray: () => () => undefined,
  };
}

describe('PopoutPlayerStage session guard & fail-closed teardown (Wave Q5-A)', () => {
  let origBc: unknown;

  beforeEach(() => {
    hookState.reset();
    FakeBroadcastChannel.channels.clear();
    origBc = (globalThis as Record<string, unknown>).BroadcastChannel;
    (globalThis as Record<string, unknown>).BroadcastChannel = FakeBroadcastChannel;
    profileMock.activeProfileId = 'default';
    profileMock.parentalUnlocked = true;
    profileMock.parentalLoadError = false;
    profileMock.lockParentalNow.mockClear();
  });

  afterEach(() => {
    hookState.unmount();
    (globalThis as Record<string, unknown>).BroadcastChannel = origBc;
  });

  it('wires a real PlaybackGuard to PlayerScreen that stops registered session and closes Popout on matching source deletion', async () => {
    const closePopout = vi.fn(async () => undefined);
    const props: PopoutPlayerStageProps = {
      catalog: {
        listSources: vi.fn(async () => []),
        resolveStream: vi.fn(async () => ok({ url: 'http://127.0.0.1/live.ts', headers: {} })),
      } as unknown as CatalogService,
      videoHost: { open: vi.fn(async () => null) } as VideoHost,
      windowBridge: makeWindowBridge(
        { itemKey: 'live:src1:ch1', kind: 'live', title: 'News', sourceId: 'src1' },
        closePopout,
      ),
    };

    renderStage(props);
    await Promise.resolve();
    await Promise.resolve();
    const tree = renderStage(props);
    const player = findByType(tree, 'PlayerScreen');
    if (!player) throw new Error('expected PlayerScreen');

    const guard = player.props.playbackGuard as PlaybackGuard;
    const stopSession = vi.fn();
    guard.registerSession?.({ getSourceId: () => 'src1', stop: stopSession });

    // Unrelated source deletion does not stop or close Popout
    guard.stopIfUsingSource('src-other');
    expect(stopSession).not.toHaveBeenCalled();
    expect(closePopout).not.toHaveBeenCalled();

    // Matching source deletion stops session and closes Popout
    guard.stopIfUsingSource('src1');
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(closePopout).toHaveBeenCalledTimes(1);
  });

  it('closes Popout immediately on profile-switch and matching source-deleted BroadcastChannel events', async () => {
    const closePopout = vi.fn(async () => undefined);
    const props: PopoutPlayerStageProps = {
      catalog: {
        listSources: vi.fn(async () => []),
        resolveStream: vi.fn(async () => ok({ url: 'http://127.0.0.1/live.ts', headers: {} })),
      } as unknown as CatalogService,
      videoHost: { open: vi.fn(async () => null) } as VideoHost,
      windowBridge: makeWindowBridge(
        { itemKey: 'live:src1:ch1', kind: 'live', title: 'News', sourceId: 'src1' },
        closePopout,
      ),
    };

    renderStage(props);
    await Promise.resolve();
    await Promise.resolve();
    renderStage(props);

    const sender = new FakeBroadcastChannel('elv-session-guard');
    sender.postMessage({ type: 'source-deleted', sourceId: 'src-other' });
    expect(closePopout).not.toHaveBeenCalled();

    sender.postMessage({ type: 'source-deleted', sourceId: 'src1' });
    expect(closePopout).toHaveBeenCalledTimes(1);
    sender.close();
  });

  it('closes Popout on profile-switch BroadcastChannel event', async () => {
    const closePopout = vi.fn(async () => undefined);
    const props: PopoutPlayerStageProps = {
      catalog: {
        resolveStream: vi.fn(async () => ok({ url: 'http://127.0.0.1/live.ts', headers: {} })),
      } as unknown as CatalogService,
      videoHost: { open: vi.fn(async () => null) } as VideoHost,
      windowBridge: makeWindowBridge(
        { itemKey: 'live:src1:ch1', kind: 'live', title: 'News', sourceId: 'src1' },
        closePopout,
      ),
    };

    renderStage(props);
    await Promise.resolve();
    await Promise.resolve();
    renderStage(props);

    const sender = new FakeBroadcastChannel('elv-session-guard');
    sender.postMessage({ type: 'profile-switch', profileId: 'kids-1' });
    expect(closePopout).toHaveBeenCalledTimes(1);
    sender.close();
  });

  it('locks local profile and re-validates active stream on parental-relock, closing Popout when parental-locked', async () => {
    const closePopout = vi.fn(async () => undefined);
    const resolveStream = vi.fn(async () => err(elvError('auth', 'parental-locked')));
    const props: PopoutPlayerStageProps = {
      catalog: { resolveStream } as unknown as CatalogService,
      videoHost: { open: vi.fn(async () => null) } as VideoHost,
      windowBridge: makeWindowBridge(
        { itemKey: 'movie:src1:adult', kind: 'movie', title: 'Late Movie', sourceId: 'src1' },
        closePopout,
      ),
    };

    renderStage(props);
    await Promise.resolve();
    await Promise.resolve();
    renderStage(props);

    const sender = new FakeBroadcastChannel('elv-session-guard');
    sender.postMessage({ type: 'parental-relock', profileId: 'default' });
    await flushMicrotasks();

    expect(profileMock.lockParentalNow).toHaveBeenCalledTimes(1);
    expect(resolveStream).toHaveBeenCalledWith('movie:src1:adult', {
      profileId: 'default',
      parentalUnlocked: false,
    });
    expect(closePopout).toHaveBeenCalledTimes(1);
    sender.close();
  });

  it('keeps Popout open on parental-relock when active stream remains permitted, and closes on local parentalLoadError or source removal via catalog.onChanged', async () => {
    const closePopout = vi.fn(async () => undefined);
    let catalogChangedListener: (() => void) | undefined;
    const catalogBridge = {
      onChanged: vi.fn((fn: () => void) => {
        catalogChangedListener = fn;
        return () => undefined;
      }),
    } as unknown as CatalogBridge;
    let sources = [{ id: 'src1', kind: 'm3u', name: 'Demo', createdAt: 1, needsImport: false }];
    const resolveStream = vi.fn(async () => ok({ url: 'http://127.0.0.1/safe.ts', headers: {} }));
    const props: PopoutPlayerStageProps = {
      catalog: {
        resolveStream,
        listSources: vi.fn(async () => sources),
      } as unknown as CatalogService,
      videoHost: { open: vi.fn(async () => null) } as VideoHost,
      windowBridge: makeWindowBridge(
        { itemKey: 'live:src1:safe', kind: 'live', title: 'Kids News', sourceId: 'src1' },
        closePopout,
      ),
      catalogBridge,
    };

    renderStage(props);
    await Promise.resolve();
    await Promise.resolve();
    renderStage(props);

    const sender = new FakeBroadcastChannel('elv-session-guard');
    sender.postMessage({ type: 'parental-relock', profileId: 'default' });
    await Promise.resolve();
    await Promise.resolve();
    expect(closePopout).not.toHaveBeenCalled();

    // Source removed in SQLite -> catalog.onChanged detects missing sourceId and closes Popout
    sources = [];
    catalogChangedListener?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(closePopout).toHaveBeenCalledTimes(1);
    sender.close();

    // Fresh mount: local parentalLoadError = true closes Popout immediately
    hookState.unmount();
    const closeOnLoadErr = vi.fn(async () => undefined);
    profileMock.parentalLoadError = true;
    const props2: PopoutPlayerStageProps = {
      catalog: { resolveStream } as unknown as CatalogService,
      videoHost: { open: vi.fn(async () => null) } as VideoHost,
      windowBridge: makeWindowBridge(
        { itemKey: 'live:src1:safe', kind: 'live', title: 'Kids News', sourceId: 'src1' },
        closeOnLoadErr,
      ),
    };
    renderStage(props2);
    await Promise.resolve();
    await Promise.resolve();
    renderStage(props2);
    expect(closeOnLoadErr).toHaveBeenCalledTimes(1);
  });

  it('wraps PlayerScreen catalog with profile scope, unmounts PlayerScreen immediately on stopAndExit even if closePopout hangs, and catches early parental-relock / locked launch payloads', async () => {
    // 1. Early parental-relock before getPopoutPayload resolves MUST still close once payload arrives
    let resolvePayload!: (p: PopoutLaunchPayload) => void;
    const neverResolvingClose = vi.fn(() => new Promise<void>(() => undefined));
    const resolveStream = vi.fn(async () => err(elvError('auth', 'parental-locked')));
    const rawCatalog = {
      listSources: vi.fn(async () => [
        { id: 'src1', kind: 'm3u', name: 'Demo', createdAt: 1, needsImport: false },
      ]),
      resolveStream,
    } as unknown as CatalogService;
    const wb = makeWindowBridge(
      { itemKey: 'movie:src1:adult', kind: 'movie', title: 'Late Movie', sourceId: 'src1' },
      neverResolvingClose,
    );
    wb.getPopoutPayload = vi.fn(
      () =>
        new Promise<PopoutLaunchPayload>((resolve) => {
          resolvePayload = resolve;
        }),
    );

    const props: PopoutPlayerStageProps = {
      catalog: rawCatalog,
      videoHost: { open: vi.fn(async () => null) } as VideoHost,
      windowBridge: wb,
    };

    renderStage(props);
    const sender = new FakeBroadcastChannel('elv-session-guard');
    // Broadcast arrives BEFORE launch payload resolves!
    sender.postMessage({ type: 'parental-relock', profileId: 'default' });

    resolvePayload({
      itemKey: 'movie:src1:adult',
      kind: 'movie',
      title: 'Late Movie',
      sourceId: 'src1',
    });
    await flushMicrotasks();
    const afterRelockTree = renderStage(props);
    expect(neverResolvingClose).toHaveBeenCalledTimes(1);
    // setSession(null) must unmount PlayerScreen immediately even though closePopout never resolved
    expect(findByType(afterRelockTree, 'PlayerScreen')).toBeNull();
    sender.close();

    // 2. Verify PlayerScreen receives a profile-scoped catalog (not rawCatalog) and excludes sources
    hookState.unmount();
    profileMock.activeProfileId = 'kids-1';
    profileMock.parentalUnlocked = false;
    const closeExcluded = vi.fn(async () => undefined);
    const resolveAllowed = vi.fn(async () => ok({ url: 'http://127.0.0.1/live.ts', headers: {} }));
    const excludedRawCatalog = {
      listSources: vi.fn(async () => [
        {
          id: 'src-adult',
          kind: 'm3u',
          name: 'Adult',
          createdAt: 1,
          needsImport: false,
          excludedProfileIds: ['kids-1'],
        },
      ]),
      resolveStream: resolveAllowed,
    } as unknown as CatalogService;
    const propsExcluded: PopoutPlayerStageProps = {
      catalog: excludedRawCatalog,
      videoHost: { open: vi.fn(async () => null) } as VideoHost,
      windowBridge: makeWindowBridge(
        { itemKey: 'm:src-adult:live:1', kind: 'live', title: 'Hidden', sourceId: 'src-adult' },
        closeExcluded,
      ),
    };
    renderStage(propsExcluded);
    await flushMicrotasks();
    const excludedTree = renderStage(propsExcluded);
    expect(closeExcluded).toHaveBeenCalledTimes(1);
    expect(findByType(excludedTree, 'PlayerScreen')).toBeNull();
    expect(resolveAllowed).not.toHaveBeenCalled();

    // 3. Permitted stream passes scoped catalog (not rawCatalog) to PlayerScreen
    hookState.unmount();
    profileMock.activeProfileId = 'default';
    profileMock.parentalUnlocked = true;
    const closeSafe = vi.fn(async () => undefined);
    const safeRawCatalog = {
      listSources: vi.fn(async () => [
        { id: 'src1', kind: 'm3u', name: 'Demo', createdAt: 1, needsImport: false },
      ]),
      resolveStream: resolveAllowed,
    } as unknown as CatalogService;
    const propsSafe: PopoutPlayerStageProps = {
      catalog: safeRawCatalog,
      videoHost: { open: vi.fn(async () => null) } as VideoHost,
      windowBridge: makeWindowBridge(
        { itemKey: 'm:src1:live:1', kind: 'live', title: 'News', sourceId: 'src1' },
        closeSafe,
      ),
    };
    renderStage(propsSafe);
    await Promise.resolve();
    await Promise.resolve();
    const safeTree = renderStage(propsSafe);
    const player = findByType(safeTree, 'PlayerScreen');
    expect(player).not.toBeNull();
    expect(player?.props.catalog).not.toBe(safeRawCatalog);
  });
});
