import {
  type BufferPreset,
  clampFontScale,
  clampPlayerVolume,
  DEFAULT_PREF_OVERSCAN,
  type ExtendedPreferencesFields,
  isBufferPreset,
  isRecord,
  isValidShortString,
  mergeExtendedPreferences,
  parseExtendedPreferences,
  serializeExtendedPreferences,
  utf8ByteLength,
} from './preferences-validators';
import { DEFAULT_WAVE_F7A_PREFERENCES } from './preferences-wave-f7a';
import { elvError, err, ok, type Result } from './result';
import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyleConfig } from './subtitle-style';

export {
  ACCESSIBILITY_FONT_FAMILIES,
  type AccessibilityFontFamily,
  ANDROID_DECODER_MODES,
  type AndroidDecoderMode,
  type ArtworkCacheLimitMbPref,
  BUFFER_PRESETS,
  type BufferPreset,
  type CatalogRefreshHoursPref,
  clampOverscan,
  DEFAULT_PREF_OVERSCAN,
  DEINTERLACE_MODES,
  type DefaultLiveModePref,
  type DefaultResizeModePref,
  type DeinterlaceMode,
  EPG_ROW_DENSITIES,
  type EpgRowDensity,
  type EpgTimeSpanHoursPref,
  type GuideRefreshHoursPref,
  isAccessibilityFontFamily,
  isAndroidDecoderMode,
  isDeinterlaceMode,
  isEpgRowDensity,
  isTvClockMode,
  type LiveChannelSwitchModePref,
  type LogoBackdropModePref,
  MAX_PREF_FONT_SCALE,
  MAX_PREF_OVERSCAN,
  MAX_PREF_PLAYER_VOLUME,
  MIN_PREF_FONT_SCALE,
  MIN_PREF_OVERSCAN,
  MIN_PREF_PLAYER_VOLUME,
  type OsdTimeDisplayMode,
  type SeekStepSecPref,
  type SleepTimerAction,
  type SubtitleModePref,
  TV_CLOCK_MODES,
  type TvClockMode,
} from './preferences-validators';
export {
  AUDIO_CHANNEL_LAYOUTS,
  AUDIO_PASSTHROUGH_CODECS,
  AUTO_FRAME_RATE_MODES,
  type AudioChannelLayout,
  type AudioPassthroughCodec,
  type AutoFrameRateMode,
  DEFAULT_AUDIO_PASSTHROUGH_CODECS,
  isAudioChannelLayout,
  isAudioPassthroughCodec,
  isAutoFrameRateMode,
  isNightModeDrcPreset,
  isRefreshRateBucket,
  MAX_REFRESH_RATE_AUDIO_DELAY_MS,
  MIN_REFRESH_RATE_AUDIO_DELAY_MS,
  NIGHT_MODE_DRC_PRESETS,
  type NightModeDrcPreset,
  normalizeAudioDelayByRefreshRateMs,
  normalizeAudioPassthroughCodecs,
  REFRESH_RATE_BUCKETS,
  type RefreshRateBucket,
} from './preferences-wave-f7a';

/** Schema version stored inside serialized preferences payloads. */
export const PREFERENCES_SCHEMA_VERSION = 1 as const;

/** Maximum serialized UTF-8 byte budget for user preferences (well under tvOS's 500 KB UserDefaults limit). */
export const MAX_PREFERENCES_BYTES = 4096;

const DEFAULT_PREFERENCES_KEY = 'elv.preferences.v1';

/** Immutable snapshot of user-configurable app preferences. */
export interface PreferencesSnapshot extends ExtendedPreferencesFields {
  readonly version: typeof PREFERENCES_SCHEMA_VERSION;
  readonly themePreset: string;
  readonly locale: string;
  readonly fontScale: number;
  readonly reduceMotion: boolean;
  readonly bufferPreset: BufferPreset;
  readonly useTextureView: boolean;
  readonly autoSubtitlesOnSkipBack: boolean;
  readonly autoPlayNextEpisode: boolean;
  readonly playerVolume: number;
}

/** Default preferences applied on fresh installs, reset, or corrupt storage recovery. */
export const DEFAULT_PREFERENCES: PreferencesSnapshot = Object.freeze({
  version: PREFERENCES_SCHEMA_VERSION,
  themePreset: 'obsidianCrimson',
  locale: 'system',
  fontScale: 1,
  reduceMotion: false,
  bufferPreset: 'auto',
  useTextureView: false,
  autoSubtitlesOnSkipBack: false,
  autoPlayNextEpisode: true,
  playerVolume: 100,
  preferredAudioLang: '',
  preferredSubtitleLang: '',
  preferredAudioLanguages: Object.freeze([]),
  preferredSubtitleLanguages: Object.freeze([]),
  preferDefaultAudioTrack: true,
  preferHevcOverDolbyVision: false,
  filterSdhSubtitles: false,
  subtitleMode: 'smart',
  seekStepSec: 10,
  defaultResizeMode: 'fit',
  osdTimeDisplayMode: 'total',
  oledScreensaverTimeoutMin: 0,
  stillWatchingTimeoutMin: 0,
  sleepTimerDefaultAction: 'stop',
  epgTimeSpanHours: 3,
  epgRowDensity: 'comfortable',
  epgGenreTints: true,
  epgShowClock: true,
  defaultLiveMode: 'favorites',
  guideRefreshHours: 12,
  catalogRefreshHours: 24,
  liveChannelSwitchMode: 'instant',
  logoBackdropMode: 'plate',
  showSourceBadges: true,
  liveOkTwoStepPreview: false,
  cleanChannelTitles: false,
  artworkCacheLimitMb: 128,
  confirmExitOnBack: true,
  preferredAudioDevice: 'auto',
  androidDecoderMode: 'auto',
  collapseLiveVariants: false,
  groupVodVersions: true,
  uiFontFamily: 'system',
  subtitleFontFamily: 'system',
  tvClockMode: 'always',
  overscanX: DEFAULT_PREF_OVERSCAN,
  overscanY: DEFAULT_PREF_OVERSCAN,
  deinterlaceMode: 'off',
  pitchLock: true,
  audioNormalization: false,
  windowAspectRatioLock: false,
  backgroundAudioPlayback: false,
  vodEnrichmentEnabled: false,
  minimizeToTray: false,
  autoEnterPip: true,
  ...DEFAULT_WAVE_F7A_PREFERENCES,
  subtitleStyle: DEFAULT_SUBTITLE_STYLE,
});

/** Partial update applied on top of the current {@link PreferencesSnapshot}. */
export type PreferencesPatch = Partial<Omit<PreferencesSnapshot, 'version' | 'subtitleStyle'>> & {
  readonly subtitleStyle?: Partial<SubtitleStyleConfig>;
};

/** Minimal key-value storage backend for persisting serialized preferences. */
export interface PreferencesKvBackend {
  get(key: string): Promise<string | undefined> | string | undefined;
  set(key: string, value: string): Promise<void> | void;
  delete?(key: string): Promise<void> | void;
}

/** Options for {@link createKvPreferencesStore}. */
export interface PreferencesStoreOptions {
  /**
   * Debounce window (ms) for coalescing rapid `update()` writes into a single `backend.set()` call.
   * Defaults to `0` (immediate writes).
   */
  coalesceMs?: number;
  /** Injectable timer scheduler for deterministic tests (defaults to `globalThis.setTimeout`). */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Injectable timer canceller for deterministic tests (defaults to `globalThis.clearTimeout`). */
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Port for reading, updating, resetting, flushing, and observing user preferences. */
export interface PreferencesStore {
  load(): Promise<PreferencesSnapshot>;
  update(patch: PreferencesPatch): Promise<Result<PreferencesSnapshot>>;
  reset(): Promise<Result<PreferencesSnapshot>>;
  flush?(): Promise<void>;
  subscribe(listener: (snapshot: PreferencesSnapshot) => void): () => void;
}

/**
 * Decodes a serialized preferences payload, falling back cleanly to {@link DEFAULT_PREFERENCES}
 * on missing/invalid JSON, mismatched schema versions, invalid field types, or strings over 64 characters.
 * Clamps `fontScale` to `[MIN_PREF_FONT_SCALE, MAX_PREF_FONT_SCALE]`.
 */
export function parsePreferences(raw: string | undefined): PreferencesSnapshot {
  if (raw === undefined || raw === '') return DEFAULT_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (!isRecord(parsed) || parsed.version !== PREFERENCES_SCHEMA_VERSION) {
    return DEFAULT_PREFERENCES;
  }
  const themePreset = isValidShortString(parsed.themePreset)
    ? parsed.themePreset
    : DEFAULT_PREFERENCES.themePreset;
  const locale = isValidShortString(parsed.locale) ? parsed.locale : DEFAULT_PREFERENCES.locale;
  const fontScale =
    typeof parsed.fontScale === 'number' && Number.isFinite(parsed.fontScale)
      ? clampFontScale(parsed.fontScale)
      : DEFAULT_PREFERENCES.fontScale;
  const reduceMotion =
    typeof parsed.reduceMotion === 'boolean'
      ? parsed.reduceMotion
      : DEFAULT_PREFERENCES.reduceMotion;
  const bufferPreset = isBufferPreset(parsed.bufferPreset)
    ? parsed.bufferPreset
    : DEFAULT_PREFERENCES.bufferPreset;
  const useTextureView =
    typeof parsed.useTextureView === 'boolean'
      ? parsed.useTextureView
      : DEFAULT_PREFERENCES.useTextureView;
  const autoSubtitlesOnSkipBack =
    typeof parsed.autoSubtitlesOnSkipBack === 'boolean'
      ? parsed.autoSubtitlesOnSkipBack
      : DEFAULT_PREFERENCES.autoSubtitlesOnSkipBack;
  const autoPlayNextEpisode =
    typeof parsed.autoPlayNextEpisode === 'boolean'
      ? parsed.autoPlayNextEpisode
      : DEFAULT_PREFERENCES.autoPlayNextEpisode;
  const playerVolume =
    typeof parsed.playerVolume === 'number' && Number.isFinite(parsed.playerVolume)
      ? clampPlayerVolume(parsed.playerVolume)
      : DEFAULT_PREFERENCES.playerVolume;

  return Object.freeze({
    version: PREFERENCES_SCHEMA_VERSION,
    themePreset,
    locale,
    fontScale,
    reduceMotion,
    bufferPreset,
    useTextureView,
    autoSubtitlesOnSkipBack,
    autoPlayNextEpisode,
    playerVolume,
    ...parseExtendedPreferences(parsed, DEFAULT_PREFERENCES),
  });
}

/**
 * Encodes a {@link PreferencesSnapshot} to JSON while enforcing {@link MAX_PREFERENCES_BYTES}
 * in UTF-8 byte length. Returns `storage/preferences-too-large` if the serialized payload exceeds budget.
 */
export function serializePreferences(snapshot: PreferencesSnapshot): Result<string> {
  const payload = JSON.stringify({
    version: PREFERENCES_SCHEMA_VERSION,
    themePreset: snapshot.themePreset,
    locale: snapshot.locale,
    fontScale: Number.isFinite(snapshot.fontScale)
      ? clampFontScale(snapshot.fontScale)
      : DEFAULT_PREFERENCES.fontScale,
    reduceMotion: Boolean(snapshot.reduceMotion),
    bufferPreset: isBufferPreset(snapshot.bufferPreset)
      ? snapshot.bufferPreset
      : DEFAULT_PREFERENCES.bufferPreset,
    useTextureView: Boolean(snapshot.useTextureView),
    autoSubtitlesOnSkipBack: Boolean(snapshot.autoSubtitlesOnSkipBack),
    autoPlayNextEpisode: Boolean(snapshot.autoPlayNextEpisode),
    playerVolume:
      typeof snapshot.playerVolume === 'number' && Number.isFinite(snapshot.playerVolume)
        ? clampPlayerVolume(snapshot.playerVolume)
        : DEFAULT_PREFERENCES.playerVolume,
    ...serializeExtendedPreferences(snapshot, DEFAULT_PREFERENCES),
  });
  if (utf8ByteLength(payload) > MAX_PREFERENCES_BYTES) {
    return err(elvError('storage', 'preferences-too-large'));
  }
  return ok(payload);
}

function mergeCandidate(base: PreferencesSnapshot, patch: PreferencesPatch): PreferencesSnapshot {
  const themePreset = isValidShortString(patch.themePreset) ? patch.themePreset : base.themePreset;
  const locale = isValidShortString(patch.locale) ? patch.locale : base.locale;
  const fontScale =
    typeof patch.fontScale === 'number' && Number.isFinite(patch.fontScale)
      ? clampFontScale(patch.fontScale)
      : base.fontScale;
  const reduceMotion =
    typeof patch.reduceMotion === 'boolean' ? patch.reduceMotion : base.reduceMotion;
  const bufferPreset = isBufferPreset(patch.bufferPreset) ? patch.bufferPreset : base.bufferPreset;
  const useTextureView =
    typeof patch.useTextureView === 'boolean' ? patch.useTextureView : base.useTextureView;
  const autoSubtitlesOnSkipBack =
    typeof patch.autoSubtitlesOnSkipBack === 'boolean'
      ? patch.autoSubtitlesOnSkipBack
      : base.autoSubtitlesOnSkipBack;
  const autoPlayNextEpisode =
    typeof patch.autoPlayNextEpisode === 'boolean'
      ? patch.autoPlayNextEpisode
      : base.autoPlayNextEpisode;
  const playerVolume =
    typeof patch.playerVolume === 'number' && Number.isFinite(patch.playerVolume)
      ? clampPlayerVolume(patch.playerVolume)
      : base.playerVolume;
  return Object.freeze({
    version: PREFERENCES_SCHEMA_VERSION,
    themePreset,
    locale,
    fontScale,
    reduceMotion,
    bufferPreset,
    useTextureView,
    autoSubtitlesOnSkipBack,
    autoPlayNextEpisode,
    playerVolume,
    ...mergeExtendedPreferences(base, patch),
  });
}

function mergeRawCandidate(
  base: PreferencesSnapshot,
  patch: PreferencesPatch,
): PreferencesSnapshot {
  return {
    version: PREFERENCES_SCHEMA_VERSION,
    themePreset:
      typeof patch.themePreset === 'string' && patch.themePreset.trim().length > 0
        ? patch.themePreset
        : base.themePreset,
    locale:
      typeof patch.locale === 'string' && patch.locale.trim().length > 0
        ? patch.locale
        : base.locale,
    fontScale:
      typeof patch.fontScale === 'number' && Number.isFinite(patch.fontScale)
        ? clampFontScale(patch.fontScale)
        : base.fontScale,
    reduceMotion: typeof patch.reduceMotion === 'boolean' ? patch.reduceMotion : base.reduceMotion,
    bufferPreset: isBufferPreset(patch.bufferPreset) ? patch.bufferPreset : base.bufferPreset,
    useTextureView:
      typeof patch.useTextureView === 'boolean' ? patch.useTextureView : base.useTextureView,
    autoSubtitlesOnSkipBack:
      typeof patch.autoSubtitlesOnSkipBack === 'boolean'
        ? patch.autoSubtitlesOnSkipBack
        : base.autoSubtitlesOnSkipBack,
    autoPlayNextEpisode:
      typeof patch.autoPlayNextEpisode === 'boolean'
        ? patch.autoPlayNextEpisode
        : base.autoPlayNextEpisode,
    playerVolume:
      typeof patch.playerVolume === 'number' && Number.isFinite(patch.playerVolume)
        ? clampPlayerVolume(patch.playerVolume)
        : base.playerVolume,
    ...mergeExtendedPreferences(base, patch),
  };
}

/**
 * Creates a {@link PreferencesStore} backed by a {@link PreferencesKvBackend}.
 * Concurrent `load`, `update`, and `reset` calls are serialized via an internal promise queue so rapid
 * toggles never race or clobber one another; subscriber exceptions are isolated.
 * When `opts.coalesceMs > 0`, rapid `update()` calls update in-memory state and notify subscribers
 * immediately while coalescing `backend.set()` writes into a single debounced commit.
 */
export function createKvPreferencesStore(
  backend: PreferencesKvBackend,
  key = DEFAULT_PREFERENCES_KEY,
  opts?: PreferencesStoreOptions,
): PreferencesStore {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new Error('Preferences key must be a non-empty string');
  }
  const coalesceMs =
    opts?.coalesceMs !== undefined && Number.isFinite(opts.coalesceMs)
      ? Math.max(0, opts.coalesceMs)
      : 0;
  const setTimer =
    opts?.setTimeoutFn ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearTimer =
    opts?.clearTimeoutFn ??
    ((handle: ReturnType<typeof setTimeout>) => {
      globalThis.clearTimeout(handle);
    });

  let current: PreferencesSnapshot = DEFAULT_PREFERENCES;
  let committed: PreferencesSnapshot = DEFAULT_PREFERENCES;
  let hydrated = false;
  let tail: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(snapshot: PreferencesSnapshot) => void>();

  interface PendingWrite {
    timer: ReturnType<typeof setTimeout> | undefined;
    encoded: string;
    snapshot: PreferencesSnapshot;
    waiters: Array<(res: Result<PreferencesSnapshot>) => void>;
  }
  let pendingWrite: PendingWrite | undefined;

  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job);
    tail = result.catch(() => undefined);
    return result;
  };

  const notify = (snapshot: PreferencesSnapshot): void => {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(snapshot);
      } catch {
        // Isolate throwing subscribers so one listener cannot break others or fail persistence.
      }
    }
  };

  const readFromBackend = async (): Promise<PreferencesSnapshot> => {
    try {
      const raw = await backend.get(key);
      current = parsePreferences(raw);
      committed = current;
      hydrated = true;
      return current;
    } catch {
      return current;
    }
  };

  const commitPendingEntry = async (entry: PendingWrite): Promise<void> => {
    try {
      await backend.set(key, entry.encoded);
      committed = entry.snapshot;
      for (const resolve of entry.waiters) resolve(ok(entry.snapshot));
    } catch {
      if (pendingWrite === undefined) {
        current = committed;
        notify(current);
      }
      const failure = err(elvError('storage', 'preferences-write-failed'));
      for (const resolve of entry.waiters) resolve(failure);
    }
  };

  const takePending = (): PendingWrite | undefined => {
    const entry = pendingWrite;
    if (entry === undefined) return undefined;
    pendingWrite = undefined;
    if (entry.timer !== undefined) {
      clearTimer(entry.timer);
      entry.timer = undefined;
    }
    return entry;
  };

  const triggerPendingCommit = (): Promise<void> => {
    const entry = takePending();
    if (entry === undefined) return Promise.resolve();
    return enqueue(() => commitPendingEntry(entry));
  };

  return {
    load(): Promise<PreferencesSnapshot> {
      return enqueue(async () => {
        const entry = takePending();
        if (entry !== undefined) {
          await commitPendingEntry(entry);
        }
        return readFromBackend();
      });
    },

    update(patch: PreferencesPatch): Promise<Result<PreferencesSnapshot>> {
      if (coalesceMs <= 0) {
        return enqueue(async () => {
          if (!hydrated) {
            await readFromBackend();
          }
          const rawEncoded = serializePreferences(mergeRawCandidate(current, patch));
          if (!rawEncoded.ok) return rawEncoded;

          const next = mergeCandidate(current, patch);
          const encoded = serializePreferences(next);
          if (!encoded.ok) return encoded;

          try {
            await backend.set(key, encoded.value);
          } catch {
            return err(elvError('storage', 'preferences-write-failed'));
          }
          current = next;
          committed = next;
          hydrated = true;
          notify(current);
          return ok(current);
        });
      }

      return enqueue(async (): Promise<{ commit: Promise<Result<PreferencesSnapshot>> }> => {
        if (!hydrated) {
          await readFromBackend();
        }
        const rawEncoded = serializePreferences(mergeRawCandidate(current, patch));
        if (!rawEncoded.ok) return { commit: Promise.resolve(rawEncoded) };

        const next = mergeCandidate(current, patch);
        const encoded = serializePreferences(next);
        if (!encoded.ok) return { commit: Promise.resolve(encoded) };

        current = next;
        hydrated = true;
        notify(current);

        const commit = new Promise<Result<PreferencesSnapshot>>((resolve) => {
          if (pendingWrite !== undefined) {
            if (pendingWrite.timer !== undefined) {
              clearTimer(pendingWrite.timer);
            }
            pendingWrite.encoded = encoded.value;
            pendingWrite.snapshot = next;
            pendingWrite.waiters.push(resolve);
          } else {
            pendingWrite = {
              timer: undefined,
              encoded: encoded.value,
              snapshot: next,
              waiters: [resolve],
            };
          }
          pendingWrite.timer = setTimer(() => {
            void triggerPendingCommit();
          }, coalesceMs);
        });
        return { commit };
      }).then(({ commit }) => commit);
    },

    reset(): Promise<Result<PreferencesSnapshot>> {
      return enqueue(async () => {
        const superseded = takePending();
        try {
          if (backend.delete !== undefined) {
            await backend.delete(key);
          } else {
            const encoded = serializePreferences(DEFAULT_PREFERENCES);
            if (!encoded.ok) {
              if (superseded !== undefined) {
                for (const resolve of superseded.waiters) resolve(encoded);
              }
              return encoded;
            }
            await backend.set(key, encoded.value);
          }
        } catch {
          const failure = err(elvError('storage', 'preferences-write-failed'));
          if (superseded !== undefined) {
            for (const resolve of superseded.waiters) resolve(failure);
          }
          return failure;
        }
        current = DEFAULT_PREFERENCES;
        committed = DEFAULT_PREFERENCES;
        hydrated = true;
        notify(current);
        const result = ok(current);
        if (superseded !== undefined) {
          for (const resolve of superseded.waiters) resolve(result);
        }
        return result;
      });
    },

    async flush(): Promise<void> {
      await tail;
      while (pendingWrite !== undefined) {
        await triggerPendingCommit();
        await tail;
      }
    },

    subscribe(listener: (snapshot: PreferencesSnapshot) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Creates an in-memory {@link PreferencesStore}, useful for tests and ephemeral previews.
 */
export function createMemoryPreferencesStore(initial?: PreferencesPatch): PreferencesStore {
  const storage = new Map<string, string>();
  if (initial !== undefined) {
    const seed = parsePreferences(
      JSON.stringify({
        ...DEFAULT_PREFERENCES,
        ...initial,
      }),
    );
    const encoded = serializePreferences(seed);
    if (encoded.ok) storage.set(DEFAULT_PREFERENCES_KEY, encoded.value);
  }
  return createKvPreferencesStore(
    {
      get: (k) => storage.get(k),
      set: (k, v) => {
        storage.set(k, v);
      },
      delete: (k) => {
        storage.delete(k);
      },
    },
    DEFAULT_PREFERENCES_KEY,
  );
}
