import type { CatalogService } from '@elv/data';
import type { OpenVideoEngine, VideoHost } from '@elv/features';
import type { EngineEvent, PlayerEngine } from '@elv/playback';
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
  Text: 'Text',
  Pressable: 'Pressable',
  Platform: { OS: 'web', select: (spec: Record<string, unknown>) => spec.web ?? spec.default },
  StyleSheet: { create: <T>(s: T): T => s },
}));

vi.mock('@elv/features', () => ({
  AppProviders: 'AppProviders',
  createLazyCatalog: (factory: () => unknown) => factory(),
}));

vi.mock('../ui/desktop-adapters.tsx', () => ({
  createDesktopUiAdapters: () => ({}),
}));

vi.mock('@elv/ui-kit', () => ({
  Icon: 'Icon',
  UiAdaptersProvider: 'UiAdaptersProvider',
  useI18n: () => ({ t: (key: string) => key }),
  useTheme: () => ({
    colors: {
      bgCanvas: 'token-bgCanvas',
      topBarScrimStart: 'token-topBarScrimStart',
      surfaceBorder: 'token-surfaceBorder',
      scrimMedium: 'token-scrimMedium',
      liveColor: 'token-liveColor',
      textPrimary: 'token-textPrimary',
      textSecondary: 'token-textSecondary',
      actionGlassBg: 'token-actionGlassBg',
      actionGlassHoverBg: 'token-actionGlassHoverBg',
      actionGlassBorder: 'token-actionGlassBorder',
      accent: 'token-accent',
    },
    radius: { pill: 999 },
    typography: { caption: {}, micro: {} },
  }),
}));

import { PopoutPlayerStage, type PopoutPlayerStageProps } from './PopoutApp.tsx';

function findByTestId(node: unknown, testID: string): ReactElement<Record<string, unknown>> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByTestId(child, testID);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.props?.testID === testID) return el;
  return findByTestId(el.props?.children, testID);
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

describe('PopoutApp (#158)', () => {
  beforeEach(() => {
    hookState.reset();
  });

  it('resolves stream, uses theme tokens exclusively, drives controls, and releases engine before docking', async () => {
    const order: string[] = [];
    const listeners = new Set<(event: EngineEvent) => void>();
    const setMuted = vi.fn();
    const engine: PlayerEngine = {
      capabilities: {
        mpegTsOverHttp: true,
        hls: true,
        liveSeek: true,
        softwareAudioFallback: false,
        recreate: true,
        audioTrackSelection: true,
        subtitleTrackSelection: true,
      },
      load: vi.fn(),
      retry: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      stop: vi.fn(),
      recreate: vi.fn(),
      release: vi.fn(() => {
        order.push('engine.release');
      }),
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    const opened: OpenVideoEngine = {
      engine,
      setMuted,
      renderSurface: () => null,
    };
    const videoHost: VideoHost = {
      supportsMultiView: true,
      open: vi.fn(async () => opened),
    };
    const catalog = {
      resolveStream: vi.fn(async () => ({
        ok: true as const,
        value: { url: 'http://sim.test/movie.mp4', headers: {} },
      })),
    } as unknown as CatalogService;

    const initialPayload: PopoutLaunchPayload = {
      itemKey: 'movie:src1:m42',
      kind: 'movie',
      title: 'Night Screening',
      resumePositionMs: 10_000,
      pinned: true,
    };

    const dockPopout = vi.fn(async () => {
      order.push('window.dockPopout');
    });
    const setAlwaysOnTop = vi.fn(async (flag: boolean) => flag);
    const closePopout = vi.fn(async () => undefined);
    const windowBridge: WindowBridge = {
      setAlwaysOnTop,
      getAlwaysOnTop: vi.fn(async () => true),
      onAlwaysOnTopChanged: () => () => undefined,
      setAspectRatioLock: vi.fn(async (f) => f),
      setMinimizeToTray: vi.fn(async (f) => f),
      openPopout: vi.fn(async () => true),
      closePopout,
      getPopoutPayload: vi.fn(async () => initialPayload),
      onPopoutPayload: () => () => undefined,
      dockPopout,
      onPopoutDocked: () => () => undefined,
      onWindowRestored: () => () => undefined,
      onHiddenToTray: () => () => undefined,
    };

    const props: PopoutPlayerStageProps = { catalog, videoHost, windowBridge };
    renderStage(props);
    await Promise.resolve();
    await Promise.resolve();

    // Second render picks up resolved initialPayload and opens videoHost + tunes catalog
    renderStage(props);
    await Promise.resolve();
    await Promise.resolve();
    const tree = renderStage(props);

    // Every rendered color must originate from theme tokens (zero hardcoded hex)
    const renderedColors = collectStyleColors(tree);
    expect(renderedColors.length).toBeGreaterThan(0);
    for (const c of renderedColors) {
      expect(c.startsWith('token-')).toBe(true);
    }

    expect(catalog.resolveStream).toHaveBeenCalledWith('movie:src1:m42');
    expect(findByTestId(tree, 'popout-title')?.props.children).toBe('Night Screening');

    // Pin button uses player.popout.unpin when pinned=true and toggles via windowBridge
    const pinBtn = findByTestId(tree, 'popout-pin-btn');
    if (!pinBtn) throw new Error('expected popout-pin-btn');
    expect(pinBtn.props.label).toBe('player.popout.unpin');
    (pinBtn.props.onPress as () => void)();
    expect(setAlwaysOnTop).toHaveBeenCalledWith(false);

    // Mute button calls opened.setMuted(true)
    const muteBtn = findByTestId(tree, 'popout-mute-btn');
    if (!muteBtn) throw new Error('expected popout-mute-btn');
    expect(muteBtn.props.label).toBe('player.mute');
    (muteBtn.props.onPress as () => void)();
    expect(setMuted).toHaveBeenCalledWith(true);

    // Dock button releases popout mpv engine BEFORE invoking windowBridge.dockPopout
    const dockBtn = findByTestId(tree, 'popout-dock-btn');
    if (!dockBtn) throw new Error('expected popout-dock-btn');
    expect(dockBtn.props.label).toBe('player.popout.dock');
    (dockBtn.props.onPress as () => void)();
    expect(order).toEqual(['engine.release', 'window.dockPopout']);
    expect(dockPopout).toHaveBeenCalledWith({
      itemKey: 'movie:src1:m42',
      kind: 'movie',
      title: 'Night Screening',
      positionMs: 10_000,
    });

    hookState.unmount();
  });
});
