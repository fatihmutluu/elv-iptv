import type {
  DesktopMediaBridge,
  DesktopMediaCommand,
  DesktopMediaPlaybackStatus,
  DesktopMediaStateSnapshot,
} from './media-bridge.ts';
import type { DlopenFn } from './player/presenter/iosurface.ts';

/** Remote command event emitted by native `elv-macos-media.node` (`MPRemoteCommandCenter`). */
export interface MacOsMediaRemoteEvent {
  readonly type:
    | 'play'
    | 'pause'
    | 'togglePlayPause'
    | 'stop'
    | 'next'
    | 'previous'
    | 'seekBy'
    | 'seekTo';
  readonly offsetSec?: number;
  readonly positionSec?: number;
}

/** Now Playing info payload sent to `MPNowPlayingInfoCenter.defaultCenter()`. */
export interface MacOsNowPlayingInfo {
  readonly title: string;
  readonly artist?: string;
  readonly playbackState: 'playing' | 'paused' | 'stopped';
  readonly durationSec?: number;
  readonly elapsedSec?: number;
  readonly playbackRate?: number;
  readonly canGoNext: boolean;
  readonly canGoPrevious: boolean;
  readonly canSeek: boolean;
}

/** Native ABI-stable N-API v8 exports from `elv-macos-media.node` (`#301`). */
export interface MacOsMediaAddon {
  screensHaveSeparateSpaces(): boolean;
  installRemoteCommands(callback: (event: MacOsMediaRemoteEvent) => void): void;
  uninstallRemoteCommands(): void;
  setNowPlaying(info: MacOsNowPlayingInfo | null): void;
}

/** Minimal Electron `globalShortcut` subset used for guarded active-playback fallback. */
export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** Collaborators injected into {@link createMacOsMediaBridge}. */
export interface MacOsMediaBridgeDeps {
  readonly platform?: NodeJS.Platform;
  /** Pre-loaded native addon (takes precedence over `addonPath`). */
  readonly addon?: MacOsMediaAddon | null;
  /** Filesystem path to `elv-macos-media.node` loaded via `dlopenFn`. */
  readonly addonPath?: string;
  /** Injectable `process.dlopen` for testing native addon loading. */
  readonly dlopenFn?: DlopenFn;
  /** Guarded Electron `globalShortcut` fallback used ONLY while playback is active if native addon is absent. */
  readonly globalShortcut?: GlobalShortcutLike;
  /** Debounce window (ms) to suppress transient `Stopped` flashes during channel zaps (default `400`). */
  readonly navigatingDebounceMs?: number;
  /** Optional diagnostic logger. */
  readonly log?: (line: string) => void;
}

const DEFAULT_NAVIGATING_DEBOUNCE_MS = 400;

const FALLBACK_SHORTCUTS: ReadonlyArray<
  readonly [accelerator: string, command: DesktopMediaCommand]
> = [
  ['MediaPlayPause', { type: 'togglePlayPause' }],
  ['MediaNextTrack', { type: 'next' }],
  ['MediaPreviousTrack', { type: 'previous' }],
  ['MediaStop', { type: 'stop' }],
];

const NOOP_BRIDGE: DesktopMediaBridge = {
  updateState: () => undefined,
  notifySeeked: () => undefined,
  onCommand: () => () => undefined,
  dispose: () => undefined,
};

const addonCache = new Map<string, MacOsMediaAddon>();

/**
 * Loads `elv-macos-media.node` via `process.dlopen` and validates its four N-API exports.
 * Returns `undefined` safely when the addon is missing, unreadable, or invalid.
 */
export function loadMacOsMediaAddon(
  addonPath: string | undefined,
  dlopenFn: DlopenFn = process.dlopen,
): MacOsMediaAddon | undefined {
  if (!addonPath) return undefined;
  const useCache = dlopenFn === process.dlopen;
  if (useCache) {
    const cached = addonCache.get(addonPath);
    if (cached) return cached;
  }

  try {
    const mod: { exports: unknown } = { exports: {} };
    dlopenFn(mod, addonPath);
    const exportsObj = mod.exports as Partial<MacOsMediaAddon> | null | undefined;
    if (
      !exportsObj ||
      typeof exportsObj !== 'object' ||
      typeof exportsObj.screensHaveSeparateSpaces !== 'function' ||
      typeof exportsObj.installRemoteCommands !== 'function' ||
      typeof exportsObj.uninstallRemoteCommands !== 'function' ||
      typeof exportsObj.setNowPlaying !== 'function'
    ) {
      return undefined;
    }
    const addon: MacOsMediaAddon = {
      screensHaveSeparateSpaces: exportsObj.screensHaveSeparateSpaces,
      installRemoteCommands: exportsObj.installRemoteCommands,
      uninstallRemoteCommands: exportsObj.uninstallRemoteCommands,
      setNowPlaying: exportsObj.setNowPlaying,
    };
    if (useCache) addonCache.set(addonPath, addon);
    return addon;
  } catch {
    return undefined;
  }
}

/**
 * Queries macOS `[NSScreen screensHaveSeparateSpaces]` via `addon` when on `darwin`.
 * Defaults to `true` on non-macOS hosts or whenever the native addon is unavailable.
 */
export function queryMacScreensHaveSeparateSpaces(
  addon?: Pick<MacOsMediaAddon, 'screensHaveSeparateSpaces'> | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'darwin' || !addon) return true;
  try {
    return addon.screensHaveSeparateSpaces() === true;
  } catch {
    return true;
  }
}

function translateNativeEvent(event: MacOsMediaRemoteEvent): DesktopMediaCommand | undefined {
  switch (event.type) {
    case 'play':
    case 'pause':
    case 'togglePlayPause':
    case 'stop':
    case 'next':
    case 'previous':
      return { type: event.type };
    case 'seekBy':
      return typeof event.offsetSec === 'number' && Number.isFinite(event.offsetSec)
        ? { type: 'seekByUs', offsetUs: Math.round(event.offsetSec * 1_000_000) }
        : undefined;
    case 'seekTo':
      return typeof event.positionSec === 'number' && Number.isFinite(event.positionSec)
        ? { type: 'seekToUs', positionUs: Math.max(0, Math.round(event.positionSec * 1_000_000)) }
        : undefined;
  }
}

function toNowPlayingInfo(
  snapshot: DesktopMediaStateSnapshot,
  effectiveStatus: DesktopMediaPlaybackStatus,
): MacOsNowPlayingInfo | null {
  if (effectiveStatus === 'Stopped') return null;
  const playbackState: MacOsNowPlayingInfo['playbackState'] =
    effectiveStatus === 'Playing' ? 'playing' : 'paused';
  const title = snapshot.metadata?.title.trim() || 'ELV IPTV';
  const artist = snapshot.metadata?.subtitle?.trim() || 'ELV IPTV';
  const isVod = snapshot.kind === 'vod' && snapshot.durationUs > 0;
  const rate = Number.isFinite(snapshot.rate) && snapshot.rate > 0 ? snapshot.rate : 1;
  return {
    title,
    artist,
    playbackState,
    ...(isVod
      ? {
          durationSec: snapshot.durationUs / 1_000_000,
          elapsedSec: Math.max(0, snapshot.positionUs / 1_000_000),
        }
      : {}),
    playbackRate: playbackState === 'playing' ? rate : 0,
    canGoNext: snapshot.metadata?.canStepTrack === true,
    canGoPrevious: snapshot.metadata?.canStepTrack === true,
    canSeek: isVod,
  };
}

/**
 * Creates the macOS hardware media-key & Now Playing bridge (`#301`).
 * Uses native `elv-macos-media.node` (`MPRemoteCommandCenter` + `MPNowPlayingInfoCenter`, zero
 * Accessibility prompts) when available, and falls back to guarded active-playback Electron
 * `globalShortcut` registration (unregistered immediately on `Stopped` / `dispose()`) when absent.
 */
export function createMacOsMediaBridge(deps?: MacOsMediaBridgeDeps): DesktopMediaBridge {
  const platform = deps?.platform ?? process.platform;
  if (platform !== 'darwin') return NOOP_BRIDGE;

  const addon =
    deps?.addon !== undefined
      ? deps.addon
      : loadMacOsMediaAddon(deps?.addonPath, deps?.dlopenFn ?? process.dlopen);

  const debounceMs = Math.max(0, deps?.navigatingDebounceMs ?? DEFAULT_NAVIGATING_DEBOUNCE_MS);
  const listeners = new Set<(cmd: DesktopMediaCommand) => void>();
  let disposed = false;
  let publishedStatus: DesktopMediaPlaybackStatus = 'Stopped';
  let latestSnapshot: DesktopMediaStateSnapshot | undefined;
  let stopDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  const clearDebounce = (): void => {
    if (stopDebounceTimer !== undefined) {
      clearTimeout(stopDebounceTimer);
      stopDebounceTimer = undefined;
    }
  };

  const applyWithDebounce = (
    snapshot: DesktopMediaStateSnapshot,
    apply: (snap: DesktopMediaStateSnapshot, effectiveStatus: DesktopMediaPlaybackStatus) => void,
  ): void => {
    if (disposed) return;
    latestSnapshot = { ...snapshot };
    if (snapshot.status === 'Stopped' && snapshot.isNavigating && publishedStatus !== 'Stopped') {
      if (stopDebounceTimer === undefined) {
        stopDebounceTimer = setTimeout(() => {
          stopDebounceTimer = undefined;
          if (disposed || !latestSnapshot || latestSnapshot.status !== 'Stopped') return;
          publishedStatus = 'Stopped';
          apply(latestSnapshot, 'Stopped');
        }, debounceMs);
      }
      apply(snapshot, publishedStatus);
      return;
    }
    clearDebounce();
    publishedStatus = snapshot.status;
    apply(snapshot, snapshot.status);
  };

  const emitCommand = (cmd: DesktopMediaCommand): void => {
    if (disposed) return;
    for (const listener of [...listeners]) {
      try {
        listener(cmd);
      } catch {
        // isolate command subscribers
      }
    }
  };

  if (addon) {
    let installed = false;
    try {
      addon.installRemoteCommands((event) => {
        const translated = translateNativeEvent(event);
        if (translated) emitCommand(translated);
      });
      installed = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      deps?.log?.(`macos-media: failed to install remote commands (${detail})`);
    }

    const pushNative = (
      snap: DesktopMediaStateSnapshot,
      effectiveStatus: DesktopMediaPlaybackStatus,
    ): void => {
      try {
        addon.setNowPlaying(toNowPlayingInfo(snap, effectiveStatus));
      } catch {
        // ignore native Now Playing update failure
      }
    };

    return {
      updateState(snapshot) {
        applyWithDebounce(snapshot, pushNative);
      },
      notifySeeked(positionUs) {
        if (
          disposed ||
          !latestSnapshot ||
          publishedStatus === 'Stopped' ||
          !Number.isFinite(positionUs)
        ) {
          return;
        }
        latestSnapshot = { ...latestSnapshot, positionUs: Math.max(0, Math.round(positionUs)) };
        pushNative(latestSnapshot, publishedStatus);
      },
      onCommand(listener) {
        if (disposed) return () => undefined;
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        publishedStatus = 'Stopped';
        clearDebounce();
        listeners.clear();
        try {
          addon.setNowPlaying(null);
        } catch {
          // best-effort teardown
        }
        if (installed) {
          try {
            addon.uninstallRemoteCommands();
          } catch {
            // best-effort teardown
          }
        }
      },
    };
  }

  // Fallback when native addon is absent: register globalShortcut ONLY while Playing/Paused!
  const shortcuts = deps?.globalShortcut;
  const registered = new Set<string>();

  const unregisterAll = (): void => {
    if (!shortcuts || registered.size === 0) return;
    for (const accel of [...registered]) {
      registered.delete(accel);
      try {
        shortcuts.unregister(accel);
      } catch {
        // best-effort unregister
      }
    }
  };

  const registerAll = (): void => {
    if (!shortcuts || disposed) return;
    for (const [accel, cmd] of FALLBACK_SHORTCUTS) {
      if (registered.has(accel)) continue;
      try {
        if (shortcuts.register(accel, () => emitCommand(cmd))) {
          registered.add(accel);
        }
      } catch {
        // ignore shortcut registration failure
      }
    }
  };

  const applyFallback = (
    _snap: DesktopMediaStateSnapshot,
    effectiveStatus: DesktopMediaPlaybackStatus,
  ): void => {
    if (effectiveStatus === 'Playing' || effectiveStatus === 'Paused') {
      registerAll();
    } else {
      unregisterAll();
    }
  };

  return {
    updateState(snapshot) {
      applyWithDebounce(snapshot, applyFallback);
    },
    notifySeeked: () => undefined,
    onCommand(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      publishedStatus = 'Stopped';
      clearDebounce();
      unregisterAll();
      listeners.clear();
    },
  };
}
