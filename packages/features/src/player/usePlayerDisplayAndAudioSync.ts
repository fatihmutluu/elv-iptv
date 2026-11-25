import {
  type AudioChannelLayout,
  type AudioPassthroughCodec,
  type AutoFrameRateMode,
  DEFAULT_PREFERENCES,
  type NightModeDrcPreset,
  normalizeAudioDelayByRefreshRateMs,
  normalizeAudioPassthroughCodecs,
  type RefreshRateBucket,
} from '@elv/domain';
import {
  type DesktopAudioOutputConfig,
  type DisplaySyncPolicy,
  type LoadCommand,
  type PlaybackService,
  type PlaybackStatus,
  type PlaybackTimers,
  type PlayerEngine,
  refreshRateBucketKey,
  resolveEffectiveAudioDelayMs,
} from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OpenVideoEngine } from '../ports/video-host';

/** Default auto-hide duration (ms) for the non-blocking Desktop passthrough fallback notice (`#213`). */
export const PASSTHROUGH_FALLBACK_NOTICE_MS = 5_000;

/** Wave F7A playback preferences accepted by `PlayerScreen` and {@link usePlayerDisplayAndAudioSync}. */
export interface WaveF7aPlayerPreferences {
  readonly autoFrameRate?: AutoFrameRateMode | undefined;
  readonly autoDynamicRange?: boolean | undefined;
  readonly nightModeDrc?: NightModeDrcPreset | undefined;
  readonly audioDelayByRefreshRateMs?:
    | Readonly<Partial<Record<RefreshRateBucket, number>>>
    | undefined;
  readonly audioPassthrough?: boolean | undefined;
  readonly audioPassthroughCodecs?: readonly AudioPassthroughCodec[] | undefined;
  readonly audioExclusive?: boolean | undefined;
  readonly audioAc3Encode?: boolean | undefined;
  readonly audioChannelLayout?: AudioChannelLayout | undefined;
}

/** Resolved Wave F7A options injected into `LoadOptions` and live engine controls. */
export interface WaveF7aLoadOptions {
  readonly displaySync: DisplaySyncPolicy;
  readonly nightModeDrc: NightModeDrcPreset;
  readonly desktopAudioOutput: DesktopAudioOutputConfig;
}

/** Builds normalized Wave F7A load & live-control options from optional player preference props. */
export function buildWaveF7aLoadOptions(prefs: WaveF7aPlayerPreferences): WaveF7aLoadOptions {
  const autoFrameRate = prefs.autoFrameRate ?? DEFAULT_PREFERENCES.autoFrameRate;
  const autoDynamicRange = prefs.autoDynamicRange ?? DEFAULT_PREFERENCES.autoDynamicRange;
  const nightModeDrc = prefs.nightModeDrc ?? DEFAULT_PREFERENCES.nightModeDrc;
  const passthrough = prefs.audioPassthrough ?? DEFAULT_PREFERENCES.audioPassthrough;
  const codecs = normalizeAudioPassthroughCodecs(
    prefs.audioPassthroughCodecs,
    DEFAULT_PREFERENCES.audioPassthroughCodecs,
  );
  const exclusive = prefs.audioExclusive ?? DEFAULT_PREFERENCES.audioExclusive;
  const ac3Encode = prefs.audioAc3Encode ?? DEFAULT_PREFERENCES.audioAc3Encode;
  const channelLayout = prefs.audioChannelLayout ?? DEFAULT_PREFERENCES.audioChannelLayout;

  return {
    displaySync: { autoFrameRate, autoDynamicRange },
    nightModeDrc,
    desktopAudioOutput: {
      passthrough,
      codecs,
      exclusive,
      ac3Encode,
      channelLayout,
    },
  };
}

/**
 * Wraps a {@link PlayerEngine} so every `load()` call carries the latest Wave F7A `LoadOptions`
 * (`displaySync`, `nightModeDrc`, `desktopAudioOutput`) across tunes, zaps, and recovery reloads.
 */
export function wrapEngineWithWaveF7aLoadOptions(
  engine: PlayerEngine,
  getLoadOptions: () => WaveF7aLoadOptions | undefined,
): PlayerEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'load') {
        return (cmd: LoadCommand): void => {
          const extra = getLoadOptions();
          if (extra === undefined) {
            target.load(cmd);
            return;
          }
          target.load({
            ...cmd,
            options: {
              displaySync: extra.displaySync,
              nightModeDrc: extra.nightModeDrc,
              desktopAudioOutput: extra.desktopAudioOutput,
              ...cmd.options,
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Dispatches a live {@link DisplaySyncPolicy} update to the host or underlying engine. */
export function applyDisplaySyncToEngine(opened: OpenVideoEngine, policy: DisplaySyncPolicy): void {
  if (opened.setDisplaySync !== undefined) {
    opened.setDisplaySync(policy);
  } else {
    opened.engine.setDisplaySync?.(policy);
  }
}

/** Dispatches a live {@link NightModeDrcPreset} update to the host or underlying engine. */
export function applyNightModeDrcToEngine(
  opened: OpenVideoEngine,
  preset: NightModeDrcPreset,
): void {
  if (opened.setNightModeDrc !== undefined) {
    opened.setNightModeDrc(preset);
  } else {
    opened.engine.setNightModeDrc?.(preset);
  }
}

/** Dispatches a live {@link DesktopAudioOutputConfig} update to the host or underlying engine. */
export function applyDesktopAudioOutputToEngine(
  opened: OpenVideoEngine,
  config: DesktopAudioOutputConfig,
): void {
  if (opened.setDesktopAudioOutput !== undefined) {
    opened.setDesktopAudioOutput(config);
  } else {
    opened.engine.setDesktopAudioOutput?.(config);
  }
}

/**
 * Computes the effective audio delay combining the user's manual baseline with any per-refresh-rate
 * offset matching `fps`. Returns `null` when the service already holds the target effective delay.
 */
export function resolveTargetEffectiveAudioDelay(params: {
  readonly manualAudioDelayMs: number;
  readonly fps: number | undefined;
  readonly audioDelayByRefreshRateMs:
    | Readonly<Partial<Record<RefreshRateBucket, number>>>
    | undefined;
  readonly currentServiceDelayMs: number;
}): number | null {
  const effectiveMs = resolveEffectiveAudioDelayMs(
    params.manualAudioDelayMs,
    params.fps,
    params.audioDelayByRefreshRateMs,
  );
  return effectiveMs === params.currentServiceDelayMs ? null : effectiveMs;
}

/** Parameters of {@link usePlayerDisplayAndAudioSync}. */
export interface UsePlayerDisplayAndAudioSyncParams {
  readonly activeItemKey: string;
  readonly openedEngine: OpenVideoEngine | undefined;
  readonly activeService: PlaybackService | null;
  readonly statusKind: PlaybackStatus['kind'];
  readonly fps: number | undefined;
  readonly timersRef: MutableRefObject<PlaybackTimers>;
  readonly preferences: WaveF7aPlayerPreferences;
}

/** Return value of {@link usePlayerDisplayAndAudioSync}. */
export interface PlayerDisplayAndAudioSyncState {
  /** User's manual per-item A/V delay baseline (ms), unaffected by automatic refresh-rate offsets. */
  readonly manualAudioDelayMs: number;
  /** Updates the manual A/V delay baseline and immediately applies the combined effective delay. */
  readonly setManualAudioDelayMs: (nextManualMs: number) => void;
  /** True while the non-blocking Desktop audio passthrough PCM fallback pill should be visible. */
  readonly passthroughFallbackVisible: boolean;
}

/**
 * Coordinates live Wave F7A engine controls (`#115`, `#116`, `#188`, `#199`, `#213`, `#214`):
 * - Syncs AFR/HDR `DisplaySyncPolicy`, Android `nightModeDrc`, and Desktop `DesktopAudioOutputConfig`.
 * - Auto-applies per-refresh-rate A/V delay (`manual + bucketOffset`) without clobbering manual delay.
 * - Subscribes to `openedEngine.onPassthroughFallback` to surface a transient Cinema Quietude pill.
 */
export function usePlayerDisplayAndAudioSync(
  params: UsePlayerDisplayAndAudioSyncParams,
): PlayerDisplayAndAudioSyncState {
  const { activeItemKey, openedEngine, activeService, statusKind, fps, timersRef, preferences } =
    params;
  const {
    autoFrameRate = DEFAULT_PREFERENCES.autoFrameRate,
    autoDynamicRange = DEFAULT_PREFERENCES.autoDynamicRange,
    nightModeDrc = DEFAULT_PREFERENCES.nightModeDrc,
    audioDelayByRefreshRateMs,
    audioPassthrough = DEFAULT_PREFERENCES.audioPassthrough,
    audioPassthroughCodecs = DEFAULT_PREFERENCES.audioPassthroughCodecs,
    audioExclusive = DEFAULT_PREFERENCES.audioExclusive,
    audioAc3Encode = DEFAULT_PREFERENCES.audioAc3Encode,
    audioChannelLayout = DEFAULT_PREFERENCES.audioChannelLayout,
  } = preferences;

  const normalizedByRefreshRate = useMemo(
    () => normalizeAudioDelayByRefreshRateMs(audioDelayByRefreshRateMs),
    [audioDelayByRefreshRateMs],
  );
  const normalizedCodecs = useMemo(
    () =>
      normalizeAudioPassthroughCodecs(
        audioPassthroughCodecs,
        DEFAULT_PREFERENCES.audioPassthroughCodecs,
      ),
    [audioPassthroughCodecs],
  );
  const codecsKey = normalizedCodecs.join(',');
  const refreshRateBucket = refreshRateBucketKey(fps);

  const [manualState, setManualState] = useState<{
    readonly itemKey: string;
    readonly delayMs: number;
  }>(() => ({ itemKey: activeItemKey, delayMs: 0 }));

  const manualAudioDelayMs = manualState.itemKey === activeItemKey ? manualState.delayMs : 0;

  const activeItemKeyRef = useRef(activeItemKey);
  activeItemKeyRef.current = activeItemKey;
  const activeServiceRef = useRef(activeService);
  activeServiceRef.current = activeService;
  const statusKindRef = useRef(statusKind);
  statusKindRef.current = statusKind;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const byRefreshRateRef = useRef(normalizedByRefreshRate);
  byRefreshRateRef.current = normalizedByRefreshRate;

  useEffect(() => {
    setManualState((prev) =>
      prev.itemKey === activeItemKey ? prev : { itemKey: activeItemKey, delayMs: 0 },
    );
  }, [activeItemKey]);

  const setManualAudioDelayMs = useCallback((nextManualMs: number): void => {
    const clean = Number.isFinite(nextManualMs) ? Math.round(nextManualMs) : 0;
    const itemKey = activeItemKeyRef.current;
    setManualState({ itemKey, delayMs: clean });
    const svc = activeServiceRef.current;
    if (svc !== null && statusKindRef.current !== 'idle' && svc.getState().item === itemKey) {
      const effectiveMs = resolveEffectiveAudioDelayMs(
        clean,
        fpsRef.current,
        byRefreshRateRef.current,
      );
      if (effectiveMs !== (svc.getState().audioDelayMs ?? 0)) {
        svc.setAudioDelay(effectiveMs);
      }
    }
  }, []);

  useEffect(() => {
    if (openedEngine === undefined) return;
    applyDisplaySyncToEngine(openedEngine, { autoFrameRate, autoDynamicRange });
  }, [autoDynamicRange, autoFrameRate, openedEngine]);

  useEffect(() => {
    if (openedEngine === undefined) return;
    applyNightModeDrcToEngine(openedEngine, nightModeDrc);
  }, [nightModeDrc, openedEngine]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: codecsKey stabilizes normalizedCodecs content equality
  useEffect(() => {
    if (openedEngine === undefined) return;
    applyDesktopAudioOutputToEngine(openedEngine, {
      passthrough: audioPassthrough,
      codecs: normalizedCodecs,
      exclusive: audioExclusive,
      ac3Encode: audioAc3Encode,
      channelLayout: audioChannelLayout,
    });
  }, [
    audioAc3Encode,
    audioChannelLayout,
    audioExclusive,
    audioPassthrough,
    codecsKey,
    openedEngine,
  ]);

  useEffect(() => {
    if (
      activeService === null ||
      statusKind === 'idle' ||
      activeService.getState().item !== activeItemKey
    ) {
      return;
    }
    const targetEffectiveMs = resolveTargetEffectiveAudioDelay({
      manualAudioDelayMs,
      fps: refreshRateBucket !== undefined ? Number(refreshRateBucket) : undefined,
      audioDelayByRefreshRateMs: normalizedByRefreshRate,
      currentServiceDelayMs: activeService.getState().audioDelayMs ?? 0,
    });
    if (targetEffectiveMs !== null) {
      activeService.setAudioDelay(targetEffectiveMs);
    }
  }, [
    activeItemKey,
    activeService,
    manualAudioDelayMs,
    normalizedByRefreshRate,
    refreshRateBucket,
    statusKind,
  ]);

  const [passthroughFallbackVisible, setPassthroughFallbackVisible] = useState(false);
  const fallbackTimerRef = useRef<unknown>(undefined);
  const mountedRef = useRef(true);

  const clearFallbackTimer = useCallback((): void => {
    if (fallbackTimerRef.current !== undefined) {
      timersRef.current.clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = undefined;
    }
  }, [timersRef]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearFallbackTimer();
    };
  }, [clearFallbackTimer]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset stale fallback notice when switching items
  useEffect(() => {
    clearFallbackTimer();
    setPassthroughFallbackVisible(false);
  }, [activeItemKey, clearFallbackTimer]);

  useEffect(() => {
    const subscribe = openedEngine?.onPassthroughFallback;
    if (subscribe === undefined) return;
    const unsub = subscribe(() => {
      if (!mountedRef.current) return;
      clearFallbackTimer();
      setPassthroughFallbackVisible(true);
      fallbackTimerRef.current = timersRef.current.setTimeout(() => {
        fallbackTimerRef.current = undefined;
        if (mountedRef.current) setPassthroughFallbackVisible(false);
      }, PASSTHROUGH_FALLBACK_NOTICE_MS);
    });
    return () => {
      unsub();
      clearFallbackTimer();
    };
  }, [clearFallbackTimer, openedEngine, timersRef]);

  return {
    manualAudioDelayMs,
    setManualAudioDelayMs,
    passthroughFallbackVisible,
  };
}
