/** Minimum supported UI font scale multiplier. */
export const MIN_PREF_FONT_SCALE = 0.9;

/** Maximum supported UI font scale multiplier. */
export const MAX_PREF_FONT_SCALE = 1.2;

/** Minimum supported persisted player volume percentage. */
export const MIN_PREF_PLAYER_VOLUME = 0;

/** Maximum supported persisted player volume percentage. */
export const MAX_PREF_PLAYER_VOLUME = 100;

/** Supported Media3/player buffer size presets (`#147`). */
export const BUFFER_PRESETS = ['auto', 'balanced', 'large'] as const;

/** User-selectable playback buffer preset (`#147`). */
export type BufferPreset = (typeof BUFFER_PRESETS)[number];

/** Supported Android Media3 video decoder selection modes (`#411`). */
export const ANDROID_DECODER_MODES = ['auto', 'hardware', 'software'] as const;

/** User-selectable Android Media3 video decoder mode (`#411`). */
export type AndroidDecoderMode = (typeof ANDROID_DECODER_MODES)[number];

/** User-selectable default subtitle activation mode (`#393`, `#401`). */
export type SubtitleModePref = 'default' | 'smart' | 'onlyForced' | 'always' | 'off';

/** User-selectable OSD end-timestamp display mode (`#160`). */
export type OsdTimeDisplayMode = 'total' | 'remaining' | 'endsAt';

/** User-selectable sleep timer expiration action (`#160`). */
export type SleepTimerAction = 'stop' | 'pause';

/** User-selectable skip-forward / skip-back interval in seconds (`#401`). */
export type SeekStepSecPref = 5 | 10 | 15 | 30;

/** User-selectable default video aspect / resize mode (`#401`). */
export type DefaultResizeModePref = 'fit' | 'fill' | 'stretch';

/** User-selectable EPG TV guide time window in hours (`#401`). */
export type EpgTimeSpanHoursPref = 2 | 3 | 6;

/** User-selectable default landing mode for Live TV (`#401`). */
export type DefaultLiveModePref = 'favorites' | 'channels' | 'epg';

/** User-selectable EPG guide auto-refresh interval in hours (`#401`). */
export type GuideRefreshHoursPref = 6 | 12 | 24;

/** User-selectable channel logo readability backdrop treatment (`#126`, `#401`). */
export type LogoBackdropModePref = 'plate' | 'invert' | 'off';

/** User-selectable on-device artwork cache budget in MiB (`#405`). */
export type ArtworkCacheLimitMbPref = 64 | 128 | 256;

/** Extended playback, Live TV, guide, and artwork cache preference fields. */
export interface ExtendedPreferencesFields {
  readonly preferredAudioLang: string;
  readonly preferredSubtitleLang: string;
  readonly preferredAudioLanguages: readonly string[];
  readonly preferredSubtitleLanguages: readonly string[];
  readonly preferDefaultAudioTrack: boolean;
  readonly preferHevcOverDolbyVision: boolean;
  readonly filterSdhSubtitles: boolean;
  readonly subtitleMode: SubtitleModePref;
  readonly seekStepSec: SeekStepSecPref;
  readonly defaultResizeMode: DefaultResizeModePref;
  readonly osdTimeDisplayMode: OsdTimeDisplayMode;
  readonly oledScreensaverTimeoutMin: number;
  readonly stillWatchingTimeoutMin: number;
  readonly sleepTimerDefaultAction: SleepTimerAction;
  readonly epgTimeSpanHours: EpgTimeSpanHoursPref;
  readonly epgGenreTints: boolean;
  readonly epgShowClock: boolean;
  readonly defaultLiveMode: DefaultLiveModePref;
  readonly guideRefreshHours: GuideRefreshHoursPref;
  readonly logoBackdropMode: LogoBackdropModePref;
  readonly showSourceBadges: boolean;
  readonly liveOkTwoStepPreview: boolean;
  readonly cleanChannelTitles: boolean;
  readonly artworkCacheLimitMb: ArtworkCacheLimitMbPref;
  readonly confirmExitOnBack: boolean;
  readonly preferredAudioDevice: string;
  readonly androidDecoderMode: AndroidDecoderMode;
}

const MAX_PREF_STRING_LENGTH = 64;
const MAX_PREF_LANG_LENGTH = 12;
const MAX_PREFERRED_LANGUAGES = 5;
const MAX_OLED_SCREENSAVER_MIN = 60;
const MAX_STILL_WATCHING_MIN = 480;
const MAX_PREF_AUDIO_DEVICE_LENGTH = 160;
const DEFAULT_AUDIO_DEVICE = 'auto';
const PREF_LANG_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;
const UNDETERMINED_LANGS = new Set(['und', 'zxx', 'mul', 'mis', 'unknown']);

const SUBTITLE_MODES: readonly SubtitleModePref[] = [
  'default',
  'smart',
  'onlyForced',
  'always',
  'off',
];
const OSD_TIME_DISPLAY_MODES: readonly OsdTimeDisplayMode[] = ['total', 'remaining', 'endsAt'];
const SLEEP_TIMER_ACTIONS: readonly SleepTimerAction[] = ['stop', 'pause'];
const SEEK_STEP_SECS: readonly SeekStepSecPref[] = [5, 10, 15, 30];
const DEFAULT_RESIZE_MODES: readonly DefaultResizeModePref[] = ['fit', 'fill', 'stretch'];
const EPG_TIME_SPAN_HOURS: readonly EpgTimeSpanHoursPref[] = [2, 3, 6];
const DEFAULT_LIVE_MODES: readonly DefaultLiveModePref[] = ['favorites', 'channels', 'epg'];
const GUIDE_REFRESH_HOURS: readonly GuideRefreshHoursPref[] = [6, 12, 24];
const LOGO_BACKDROP_MODES: readonly LogoBackdropModePref[] = ['plate', 'invert', 'off'];
const ARTWORK_CACHE_LIMITS_MB: readonly ArtworkCacheLimitMbPref[] = [64, 128, 256];

export function clampFontScale(value: number): number {
  return Math.min(MAX_PREF_FONT_SCALE, Math.max(MIN_PREF_FONT_SCALE, value));
}

export function clampPlayerVolume(value: number): number {
  const clamped = Math.min(
    MAX_PREF_PLAYER_VOLUME,
    Math.max(MIN_PREF_PLAYER_VOLUME, Math.round(value)),
  );
  return clamped === 0 ? 0 : clamped;
}

export function isValidShortString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_PREF_STRING_LENGTH
  );
}

export function isBufferPreset(value: unknown): value is BufferPreset {
  return typeof value === 'string' && (BUFFER_PRESETS as readonly string[]).includes(value);
}

/** Returns true when `value` is a supported {@link AndroidDecoderMode}. */
export function isAndroidDecoderMode(value: unknown): value is AndroidDecoderMode {
  return typeof value === 'string' && (ANDROID_DECODER_MODES as readonly string[]).includes(value);
}

function normalizePrefLang(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PREF_LANG_LENGTH) return '';
  if (!PREF_LANG_PATTERN.test(trimmed)) return '';
  const lower = trimmed.toLowerCase();
  const primary = lower.split('-')[0] ?? lower;
  if (UNDETERMINED_LANGS.has(primary)) return '';
  return lower;
}

function normalizePrefLangList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const code = normalizePrefLang(item);
    if (code.length === 0 || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= MAX_PREFERRED_LANGUAGES) break;
  }
  return Object.freeze(out);
}

function clampTimeoutMin(value: unknown, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const clamped = Math.min(max, Math.max(0, Math.round(value)));
  return clamped === 0 ? 0 : clamped;
}

function normalizeSubtitleModePref(value: unknown, fallback: SubtitleModePref): SubtitleModePref {
  if (value === 'auto') return 'smart';
  if (value === 'none') return 'off';
  return typeof value === 'string' && (SUBTITLE_MODES as readonly string[]).includes(value)
    ? (value as SubtitleModePref)
    : fallback;
}

function isOsdTimeDisplayMode(value: unknown): value is OsdTimeDisplayMode {
  return typeof value === 'string' && (OSD_TIME_DISPLAY_MODES as readonly string[]).includes(value);
}

function isSleepTimerAction(value: unknown): value is SleepTimerAction {
  return typeof value === 'string' && (SLEEP_TIMER_ACTIONS as readonly string[]).includes(value);
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeAudioDevice(value: unknown): string {
  if (typeof value !== 'string' || hasControlChar(value)) return DEFAULT_AUDIO_DEVICE;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PREF_AUDIO_DEVICE_LENGTH) {
    return DEFAULT_AUDIO_DEVICE;
  }
  return trimmed;
}

function isSeekStepSecPref(value: unknown): value is SeekStepSecPref {
  return typeof value === 'number' && (SEEK_STEP_SECS as readonly number[]).includes(value);
}

function isDefaultResizeModePref(value: unknown): value is DefaultResizeModePref {
  return typeof value === 'string' && (DEFAULT_RESIZE_MODES as readonly string[]).includes(value);
}

function isEpgTimeSpanHoursPref(value: unknown): value is EpgTimeSpanHoursPref {
  return typeof value === 'number' && (EPG_TIME_SPAN_HOURS as readonly number[]).includes(value);
}

function isDefaultLiveModePref(value: unknown): value is DefaultLiveModePref {
  return typeof value === 'string' && (DEFAULT_LIVE_MODES as readonly string[]).includes(value);
}

function isGuideRefreshHoursPref(value: unknown): value is GuideRefreshHoursPref {
  return typeof value === 'number' && (GUIDE_REFRESH_HOURS as readonly number[]).includes(value);
}

function isLogoBackdropModePref(value: unknown): value is LogoBackdropModePref {
  return typeof value === 'string' && (LOGO_BACKDROP_MODES as readonly string[]).includes(value);
}

function isArtworkCacheLimitMbPref(value: unknown): value is ArtworkCacheLimitMbPref {
  return (
    typeof value === 'number' && (ARTWORK_CACHE_LIMITS_MB as readonly number[]).includes(value)
  );
}

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveLangPair(
  rawList: unknown,
  rawSingle: unknown,
  fallbackList: readonly string[],
): { readonly list: readonly string[]; readonly first: string } {
  if (Array.isArray(rawList)) {
    const list = normalizePrefLangList(rawList);
    return { list, first: list[0] ?? '' };
  }
  const single = normalizePrefLang(rawSingle);
  const list = single.length > 0 ? Object.freeze([single]) : fallbackList;
  return { list, first: list[0] ?? '' };
}

function resolveSerializedLangPair(
  rawList: readonly string[],
  rawSingle: string,
): { readonly list: readonly string[]; readonly first: string } {
  const list = normalizePrefLangList(rawList);
  if (list.length > 0) return { list, first: list[0] ?? '' };
  const single = normalizePrefLang(rawSingle);
  if (single.length > 0) return { list: Object.freeze([single]), first: single };
  return { list: Object.freeze([]), first: '' };
}

function mergeLangPair(
  baseList: readonly string[],
  baseSingle: string,
  patchList: readonly string[] | undefined,
  patchSingle: string | undefined,
): { readonly list: readonly string[]; readonly first: string } {
  if (Array.isArray(patchList)) {
    const list = normalizePrefLangList(patchList);
    return { list, first: list[0] ?? '' };
  }
  if (typeof patchSingle === 'string') {
    const single = normalizePrefLang(patchSingle);
    return {
      list: single.length > 0 ? Object.freeze([single]) : Object.freeze([]),
      first: single,
    };
  }
  return { list: baseList, first: baseSingle };
}

export function parseExtendedPreferences(
  parsed: Record<string, unknown>,
  defaults: ExtendedPreferencesFields,
): ExtendedPreferencesFields {
  const audio = resolveLangPair(
    parsed.preferredAudioLanguages,
    parsed.preferredAudioLang,
    defaults.preferredAudioLanguages,
  );
  const subtitle = resolveLangPair(
    parsed.preferredSubtitleLanguages,
    parsed.preferredSubtitleLang,
    defaults.preferredSubtitleLanguages,
  );
  return {
    preferredAudioLang: audio.first,
    preferredSubtitleLang: subtitle.first,
    preferredAudioLanguages: audio.list,
    preferredSubtitleLanguages: subtitle.list,
    preferDefaultAudioTrack:
      typeof parsed.preferDefaultAudioTrack === 'boolean'
        ? parsed.preferDefaultAudioTrack
        : defaults.preferDefaultAudioTrack,
    preferHevcOverDolbyVision:
      typeof parsed.preferHevcOverDolbyVision === 'boolean'
        ? parsed.preferHevcOverDolbyVision
        : defaults.preferHevcOverDolbyVision,
    filterSdhSubtitles:
      typeof parsed.filterSdhSubtitles === 'boolean'
        ? parsed.filterSdhSubtitles
        : defaults.filterSdhSubtitles,
    subtitleMode: normalizeSubtitleModePref(parsed.subtitleMode, defaults.subtitleMode),
    seekStepSec: isSeekStepSecPref(parsed.seekStepSec) ? parsed.seekStepSec : defaults.seekStepSec,
    defaultResizeMode: isDefaultResizeModePref(parsed.defaultResizeMode)
      ? parsed.defaultResizeMode
      : defaults.defaultResizeMode,
    osdTimeDisplayMode: isOsdTimeDisplayMode(parsed.osdTimeDisplayMode)
      ? parsed.osdTimeDisplayMode
      : defaults.osdTimeDisplayMode,
    oledScreensaverTimeoutMin: clampTimeoutMin(
      parsed.oledScreensaverTimeoutMin,
      MAX_OLED_SCREENSAVER_MIN,
      defaults.oledScreensaverTimeoutMin,
    ),
    stillWatchingTimeoutMin: clampTimeoutMin(
      parsed.stillWatchingTimeoutMin,
      MAX_STILL_WATCHING_MIN,
      defaults.stillWatchingTimeoutMin,
    ),
    sleepTimerDefaultAction: isSleepTimerAction(parsed.sleepTimerDefaultAction)
      ? parsed.sleepTimerDefaultAction
      : defaults.sleepTimerDefaultAction,
    epgTimeSpanHours: isEpgTimeSpanHoursPref(parsed.epgTimeSpanHours)
      ? parsed.epgTimeSpanHours
      : defaults.epgTimeSpanHours,
    epgGenreTints:
      typeof parsed.epgGenreTints === 'boolean' ? parsed.epgGenreTints : defaults.epgGenreTints,
    epgShowClock:
      typeof parsed.epgShowClock === 'boolean' ? parsed.epgShowClock : defaults.epgShowClock,
    defaultLiveMode: isDefaultLiveModePref(parsed.defaultLiveMode)
      ? parsed.defaultLiveMode
      : defaults.defaultLiveMode,
    guideRefreshHours: isGuideRefreshHoursPref(parsed.guideRefreshHours)
      ? parsed.guideRefreshHours
      : defaults.guideRefreshHours,
    logoBackdropMode: isLogoBackdropModePref(parsed.logoBackdropMode)
      ? parsed.logoBackdropMode
      : defaults.logoBackdropMode,
    showSourceBadges:
      typeof parsed.showSourceBadges === 'boolean'
        ? parsed.showSourceBadges
        : defaults.showSourceBadges,
    liveOkTwoStepPreview:
      typeof parsed.liveOkTwoStepPreview === 'boolean'
        ? parsed.liveOkTwoStepPreview
        : defaults.liveOkTwoStepPreview,
    cleanChannelTitles:
      typeof parsed.cleanChannelTitles === 'boolean'
        ? parsed.cleanChannelTitles
        : defaults.cleanChannelTitles,
    artworkCacheLimitMb: isArtworkCacheLimitMbPref(parsed.artworkCacheLimitMb)
      ? parsed.artworkCacheLimitMb
      : defaults.artworkCacheLimitMb,
    confirmExitOnBack:
      typeof parsed.confirmExitOnBack === 'boolean'
        ? parsed.confirmExitOnBack
        : defaults.confirmExitOnBack,
    preferredAudioDevice: normalizeAudioDevice(parsed.preferredAudioDevice),
    androidDecoderMode: isAndroidDecoderMode(parsed.androidDecoderMode)
      ? parsed.androidDecoderMode
      : defaults.androidDecoderMode,
  };
}

export function serializeExtendedPreferences(
  snapshot: ExtendedPreferencesFields,
  defaults: ExtendedPreferencesFields,
): ExtendedPreferencesFields {
  const audio = resolveSerializedLangPair(
    snapshot.preferredAudioLanguages,
    snapshot.preferredAudioLang,
  );
  const subtitle = resolveSerializedLangPair(
    snapshot.preferredSubtitleLanguages,
    snapshot.preferredSubtitleLang,
  );
  return {
    preferredAudioLang: audio.first,
    preferredSubtitleLang: subtitle.first,
    preferredAudioLanguages: audio.list,
    preferredSubtitleLanguages: subtitle.list,
    preferDefaultAudioTrack: Boolean(snapshot.preferDefaultAudioTrack),
    preferHevcOverDolbyVision: Boolean(snapshot.preferHevcOverDolbyVision),
    filterSdhSubtitles: Boolean(snapshot.filterSdhSubtitles),
    subtitleMode: normalizeSubtitleModePref(snapshot.subtitleMode, defaults.subtitleMode),
    seekStepSec: isSeekStepSecPref(snapshot.seekStepSec)
      ? snapshot.seekStepSec
      : defaults.seekStepSec,
    defaultResizeMode: isDefaultResizeModePref(snapshot.defaultResizeMode)
      ? snapshot.defaultResizeMode
      : defaults.defaultResizeMode,
    osdTimeDisplayMode: isOsdTimeDisplayMode(snapshot.osdTimeDisplayMode)
      ? snapshot.osdTimeDisplayMode
      : defaults.osdTimeDisplayMode,
    oledScreensaverTimeoutMin: clampTimeoutMin(
      snapshot.oledScreensaverTimeoutMin,
      MAX_OLED_SCREENSAVER_MIN,
      defaults.oledScreensaverTimeoutMin,
    ),
    stillWatchingTimeoutMin: clampTimeoutMin(
      snapshot.stillWatchingTimeoutMin,
      MAX_STILL_WATCHING_MIN,
      defaults.stillWatchingTimeoutMin,
    ),
    sleepTimerDefaultAction: isSleepTimerAction(snapshot.sleepTimerDefaultAction)
      ? snapshot.sleepTimerDefaultAction
      : defaults.sleepTimerDefaultAction,
    epgTimeSpanHours: isEpgTimeSpanHoursPref(snapshot.epgTimeSpanHours)
      ? snapshot.epgTimeSpanHours
      : defaults.epgTimeSpanHours,
    epgGenreTints: Boolean(snapshot.epgGenreTints),
    epgShowClock: Boolean(snapshot.epgShowClock),
    defaultLiveMode: isDefaultLiveModePref(snapshot.defaultLiveMode)
      ? snapshot.defaultLiveMode
      : defaults.defaultLiveMode,
    guideRefreshHours: isGuideRefreshHoursPref(snapshot.guideRefreshHours)
      ? snapshot.guideRefreshHours
      : defaults.guideRefreshHours,
    logoBackdropMode: isLogoBackdropModePref(snapshot.logoBackdropMode)
      ? snapshot.logoBackdropMode
      : defaults.logoBackdropMode,
    showSourceBadges: Boolean(snapshot.showSourceBadges),
    liveOkTwoStepPreview: Boolean(snapshot.liveOkTwoStepPreview),
    cleanChannelTitles: Boolean(snapshot.cleanChannelTitles),
    artworkCacheLimitMb: isArtworkCacheLimitMbPref(snapshot.artworkCacheLimitMb)
      ? snapshot.artworkCacheLimitMb
      : defaults.artworkCacheLimitMb,
    confirmExitOnBack: Boolean(snapshot.confirmExitOnBack),
    preferredAudioDevice: normalizeAudioDevice(snapshot.preferredAudioDevice),
    androidDecoderMode: isAndroidDecoderMode(snapshot.androidDecoderMode)
      ? snapshot.androidDecoderMode
      : defaults.androidDecoderMode,
  };
}

export function mergeExtendedPreferences(
  base: ExtendedPreferencesFields,
  patch: Partial<ExtendedPreferencesFields>,
): ExtendedPreferencesFields {
  const audio = mergeLangPair(
    base.preferredAudioLanguages,
    base.preferredAudioLang,
    patch.preferredAudioLanguages,
    patch.preferredAudioLang,
  );
  const subtitle = mergeLangPair(
    base.preferredSubtitleLanguages,
    base.preferredSubtitleLang,
    patch.preferredSubtitleLanguages,
    patch.preferredSubtitleLang,
  );
  return {
    preferredAudioLang: audio.first,
    preferredSubtitleLang: subtitle.first,
    preferredAudioLanguages: audio.list,
    preferredSubtitleLanguages: subtitle.list,
    preferDefaultAudioTrack:
      typeof patch.preferDefaultAudioTrack === 'boolean'
        ? patch.preferDefaultAudioTrack
        : base.preferDefaultAudioTrack,
    preferHevcOverDolbyVision:
      typeof patch.preferHevcOverDolbyVision === 'boolean'
        ? patch.preferHevcOverDolbyVision
        : base.preferHevcOverDolbyVision,
    filterSdhSubtitles:
      typeof patch.filterSdhSubtitles === 'boolean'
        ? patch.filterSdhSubtitles
        : base.filterSdhSubtitles,
    subtitleMode: normalizeSubtitleModePref(patch.subtitleMode, base.subtitleMode),
    seekStepSec: isSeekStepSecPref(patch.seekStepSec) ? patch.seekStepSec : base.seekStepSec,
    defaultResizeMode: isDefaultResizeModePref(patch.defaultResizeMode)
      ? patch.defaultResizeMode
      : base.defaultResizeMode,
    osdTimeDisplayMode: isOsdTimeDisplayMode(patch.osdTimeDisplayMode)
      ? patch.osdTimeDisplayMode
      : base.osdTimeDisplayMode,
    oledScreensaverTimeoutMin: clampTimeoutMin(
      patch.oledScreensaverTimeoutMin,
      MAX_OLED_SCREENSAVER_MIN,
      base.oledScreensaverTimeoutMin,
    ),
    stillWatchingTimeoutMin: clampTimeoutMin(
      patch.stillWatchingTimeoutMin,
      MAX_STILL_WATCHING_MIN,
      base.stillWatchingTimeoutMin,
    ),
    sleepTimerDefaultAction: isSleepTimerAction(patch.sleepTimerDefaultAction)
      ? patch.sleepTimerDefaultAction
      : base.sleepTimerDefaultAction,
    epgTimeSpanHours: isEpgTimeSpanHoursPref(patch.epgTimeSpanHours)
      ? patch.epgTimeSpanHours
      : base.epgTimeSpanHours,
    epgGenreTints:
      typeof patch.epgGenreTints === 'boolean' ? patch.epgGenreTints : base.epgGenreTints,
    epgShowClock: typeof patch.epgShowClock === 'boolean' ? patch.epgShowClock : base.epgShowClock,
    defaultLiveMode: isDefaultLiveModePref(patch.defaultLiveMode)
      ? patch.defaultLiveMode
      : base.defaultLiveMode,
    guideRefreshHours: isGuideRefreshHoursPref(patch.guideRefreshHours)
      ? patch.guideRefreshHours
      : base.guideRefreshHours,
    logoBackdropMode: isLogoBackdropModePref(patch.logoBackdropMode)
      ? patch.logoBackdropMode
      : base.logoBackdropMode,
    showSourceBadges:
      typeof patch.showSourceBadges === 'boolean' ? patch.showSourceBadges : base.showSourceBadges,
    liveOkTwoStepPreview:
      typeof patch.liveOkTwoStepPreview === 'boolean'
        ? patch.liveOkTwoStepPreview
        : base.liveOkTwoStepPreview,
    cleanChannelTitles:
      typeof patch.cleanChannelTitles === 'boolean'
        ? patch.cleanChannelTitles
        : base.cleanChannelTitles,
    artworkCacheLimitMb: isArtworkCacheLimitMbPref(patch.artworkCacheLimitMb)
      ? patch.artworkCacheLimitMb
      : base.artworkCacheLimitMb,
    confirmExitOnBack:
      typeof patch.confirmExitOnBack === 'boolean'
        ? patch.confirmExitOnBack
        : base.confirmExitOnBack,
    preferredAudioDevice:
      typeof patch.preferredAudioDevice === 'string'
        ? normalizeAudioDevice(patch.preferredAudioDevice)
        : base.preferredAudioDevice,
    androidDecoderMode: isAndroidDecoderMode(patch.androidDecoderMode)
      ? patch.androidDecoderMode
      : base.androidDecoderMode,
  };
}
