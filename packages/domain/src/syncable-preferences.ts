import { isElvCategorySource, isElvTitleFormat } from './elv-mode';
import { isHomeLayoutSectionId, normalizeHomeLayout } from './home-layout';
import type { PreferencesPatch, PreferencesSnapshot } from './preferences';
import {
  clampFontScale,
  type DefaultLiveModePref,
  type DefaultResizeModePref,
  type EpgTimeSpanHoursPref,
  isAccessibilityFontFamily,
  isEpgRowDensity,
  isRecord,
  isValidShortString,
  type SeekStepSecPref,
  type SubtitleModePref,
} from './preferences-validators';
import {
  isSubtitleBgColor,
  isSubtitleEdgeStyle,
  isSubtitleFontSize,
  isSubtitleTextColor,
  isSubtitleVerticalPosition,
  type SubtitleStyleConfig,
} from './subtitle-style';

/**
 * Strictly allowlisted visual, editorial, language, and playback-style preference keys synced
 * as an initial-only seed on first device sign-in or QR pairing (Product Decision #40).
 * Hardware, display, audio-device, cache, tray, privacy-consent, telemetry, and server-URL keys are excluded.
 */
export const SYNCABLE_PREFERENCE_KEYS = [
  'themePreset',
  'fontScale',
  'reduceMotion',
  'locale',
  'defaultResizeMode',
  'epgTimeSpanHours',
  'epgRowDensity',
  'epgShowClock',
  'defaultLiveMode',
  'groupVodVersions',
  'uiFontFamily',
  'subtitleFontFamily',
  'subtitleStyle',
  'subtitleMode',
  'preferredAudioLang',
  'preferredSubtitleLang',
  'preferredAudioLanguages',
  'preferredSubtitleLanguages',
  'autoPlayNextEpisode',
  'detailTrailerMuted',
  'seekStepSec',
  'homeLayout',
  'elvModeEnabled',
  'elvMergeVersions',
  'elvEnrichMetadata',
  'elvTitleFormat',
  'elvCategorySource',
  'elvSmartRecommendations',
  'elvXrayEnabled',
  'elvLiveEnhance',
  'elvVerifyRealQuality',
] as const;

/** Union of preference keys eligible for initial-only device seeding (Product Decision #40). */
export type SyncablePreferenceKey = (typeof SYNCABLE_PREFERENCE_KEYS)[number];

const DEFAULT_RESIZE_MODES: ReadonlySet<string> = new Set(['fit', 'fill', 'stretch']);
const EPG_TIME_SPAN_HOURS: ReadonlySet<number> = new Set([2, 3, 6]);
const DEFAULT_LIVE_MODES: ReadonlySet<string> = new Set(['favorites', 'channels', 'epg']);
const SUBTITLE_MODES: ReadonlySet<string> = new Set([
  'default',
  'smart',
  'onlyForced',
  'always',
  'off',
]);
const SEEK_STEP_SECS: ReadonlySet<number> = new Set([5, 10, 15, 30]);
const MAX_PREF_LANG_LENGTH = 12;
const MAX_PREFERRED_LANGUAGES = 5;
const PREF_LANG_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i;
const UNDETERMINED_LANGS: ReadonlySet<string> = new Set(['und', 'zxx', 'mul', 'mis', 'unknown']);

function parseValidLangCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length > MAX_PREF_LANG_LENGTH || !PREF_LANG_PATTERN.test(trimmed)) return undefined;
  const lower = trimmed.toLowerCase();
  const primary = lower.split('-')[0] ?? lower;
  if (UNDETERMINED_LANGS.has(primary)) return undefined;
  return lower;
}

function parseValidLangList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const code = parseValidLangCode(item);
    if (code === undefined || code.length === 0 || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= MAX_PREFERRED_LANGUAGES) break;
  }
  return Object.freeze(out);
}

function parseSubtitleMode(value: unknown): SubtitleModePref | undefined {
  if (value === 'auto') return 'smart';
  if (value === 'none') return 'off';
  return typeof value === 'string' && SUBTITLE_MODES.has(value)
    ? (value as SubtitleModePref)
    : undefined;
}

function parseSubtitleStylePatch(value: unknown): Partial<SubtitleStyleConfig> | undefined {
  if (!isRecord(value)) return undefined;
  const out: {
    fontSize?: SubtitleStyleConfig['fontSize'];
    textColor?: SubtitleStyleConfig['textColor'];
    backgroundColor?: SubtitleStyleConfig['backgroundColor'];
    edgeStyle?: SubtitleStyleConfig['edgeStyle'];
    verticalPosition?: SubtitleStyleConfig['verticalPosition'];
  } = {};
  if (isSubtitleFontSize(value.fontSize)) out.fontSize = value.fontSize;
  if (isSubtitleTextColor(value.textColor)) out.textColor = value.textColor;
  if (isSubtitleBgColor(value.backgroundColor)) out.backgroundColor = value.backgroundColor;
  if (isSubtitleEdgeStyle(value.edgeStyle)) out.edgeStyle = value.edgeStyle;
  if (isSubtitleVerticalPosition(value.verticalPosition)) {
    out.verticalPosition = value.verticalPosition;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Extracts only the allowlisted syncable preference fields from a {@link PreferencesSnapshot}
 * for initial-only E2EE vault seeding (Product Decision #40).
 */
export function extractSyncablePreferences(
  snapshot: PreferencesSnapshot,
): Readonly<Record<string, unknown>> {
  return {
    themePreset: snapshot.themePreset,
    fontScale: snapshot.fontScale,
    reduceMotion: snapshot.reduceMotion,
    locale: snapshot.locale,
    defaultResizeMode: snapshot.defaultResizeMode,
    epgTimeSpanHours: snapshot.epgTimeSpanHours,
    epgRowDensity: snapshot.epgRowDensity,
    epgShowClock: snapshot.epgShowClock,
    defaultLiveMode: snapshot.defaultLiveMode,
    groupVodVersions: snapshot.groupVodVersions,
    uiFontFamily: snapshot.uiFontFamily,
    subtitleFontFamily: snapshot.subtitleFontFamily,
    subtitleStyle: { ...snapshot.subtitleStyle },
    subtitleMode: snapshot.subtitleMode,
    preferredAudioLang: snapshot.preferredAudioLang,
    preferredSubtitleLang: snapshot.preferredSubtitleLang,
    preferredAudioLanguages: [...snapshot.preferredAudioLanguages],
    preferredSubtitleLanguages: [...snapshot.preferredSubtitleLanguages],
    autoPlayNextEpisode: snapshot.autoPlayNextEpisode,
    detailTrailerMuted: snapshot.detailTrailerMuted,
    seekStepSec: snapshot.seekStepSec,
    homeLayout: snapshot.homeLayout.map((s) => ({ id: s.id, visible: s.visible })),
    elvModeEnabled: snapshot.elvModeEnabled,
    elvMergeVersions: snapshot.elvMergeVersions,
    elvEnrichMetadata: snapshot.elvEnrichMetadata,
    elvTitleFormat: snapshot.elvTitleFormat,
    elvCategorySource: snapshot.elvCategorySource,
    elvSmartRecommendations: snapshot.elvSmartRecommendations,
    elvXrayEnabled: snapshot.elvXrayEnabled,
    elvLiveEnhance: snapshot.elvLiveEnhance,
    elvVerifyRealQuality: snapshot.elvVerifyRealQuality,
  };
}

/**
 * Validates and sanitizes an untrusted initial preferences payload from a remote vault into a
 * safe {@link PreferencesPatch}. Forbidden hardware/device-local keys and malformed values are
 * silently omitted so they can never corrupt local preferences.
 */
export function sanitizeInitialPreferencesPatch(raw: unknown): PreferencesPatch {
  if (!isRecord(raw)) return {};
  const patch: Record<string, unknown> = {};

  if (isValidShortString(raw.themePreset)) patch.themePreset = raw.themePreset;
  if (typeof raw.fontScale === 'number' && Number.isFinite(raw.fontScale)) {
    patch.fontScale = clampFontScale(raw.fontScale);
  }
  if (typeof raw.reduceMotion === 'boolean') patch.reduceMotion = raw.reduceMotion;
  if (isValidShortString(raw.locale)) patch.locale = raw.locale;
  if (
    typeof raw.defaultResizeMode === 'string' &&
    DEFAULT_RESIZE_MODES.has(raw.defaultResizeMode)
  ) {
    patch.defaultResizeMode = raw.defaultResizeMode as DefaultResizeModePref;
  }
  if (typeof raw.epgTimeSpanHours === 'number' && EPG_TIME_SPAN_HOURS.has(raw.epgTimeSpanHours)) {
    patch.epgTimeSpanHours = raw.epgTimeSpanHours as EpgTimeSpanHoursPref;
  }
  if (isEpgRowDensity(raw.epgRowDensity)) patch.epgRowDensity = raw.epgRowDensity;
  if (typeof raw.epgShowClock === 'boolean') patch.epgShowClock = raw.epgShowClock;
  if (typeof raw.defaultLiveMode === 'string' && DEFAULT_LIVE_MODES.has(raw.defaultLiveMode)) {
    patch.defaultLiveMode = raw.defaultLiveMode as DefaultLiveModePref;
  }
  if (typeof raw.groupVodVersions === 'boolean') patch.groupVodVersions = raw.groupVodVersions;
  if (isAccessibilityFontFamily(raw.uiFontFamily)) patch.uiFontFamily = raw.uiFontFamily;
  if (isAccessibilityFontFamily(raw.subtitleFontFamily)) {
    patch.subtitleFontFamily = raw.subtitleFontFamily;
  }

  const subtitleStyle = parseSubtitleStylePatch(raw.subtitleStyle);
  if (subtitleStyle !== undefined) patch.subtitleStyle = subtitleStyle;

  const subtitleMode = parseSubtitleMode(raw.subtitleMode);
  if (subtitleMode !== undefined) patch.subtitleMode = subtitleMode;

  const audioLang = parseValidLangCode(raw.preferredAudioLang);
  if (audioLang !== undefined) patch.preferredAudioLang = audioLang;

  const subLang = parseValidLangCode(raw.preferredSubtitleLang);
  if (subLang !== undefined) patch.preferredSubtitleLang = subLang;

  const audioLangs = parseValidLangList(raw.preferredAudioLanguages);
  if (audioLangs !== undefined) patch.preferredAudioLanguages = audioLangs;

  const subLangs = parseValidLangList(raw.preferredSubtitleLanguages);
  if (subLangs !== undefined) patch.preferredSubtitleLanguages = subLangs;

  if (typeof raw.autoPlayNextEpisode === 'boolean') {
    patch.autoPlayNextEpisode = raw.autoPlayNextEpisode;
  }
  if (typeof raw.detailTrailerMuted === 'boolean') {
    patch.detailTrailerMuted = raw.detailTrailerMuted;
  }
  if (typeof raw.seekStepSec === 'number' && SEEK_STEP_SECS.has(raw.seekStepSec)) {
    patch.seekStepSec = raw.seekStepSec as SeekStepSecPref;
  }
  if (
    Array.isArray(raw.homeLayout) &&
    raw.homeLayout.some((e) => isRecord(e) && isHomeLayoutSectionId(e.id))
  ) {
    patch.homeLayout = normalizeHomeLayout(raw.homeLayout);
  }
  if (typeof raw.elvModeEnabled === 'boolean') patch.elvModeEnabled = raw.elvModeEnabled;
  if (typeof raw.elvMergeVersions === 'boolean') patch.elvMergeVersions = raw.elvMergeVersions;
  if (typeof raw.elvEnrichMetadata === 'boolean') patch.elvEnrichMetadata = raw.elvEnrichMetadata;
  if (isElvTitleFormat(raw.elvTitleFormat)) patch.elvTitleFormat = raw.elvTitleFormat;
  if (isElvCategorySource(raw.elvCategorySource)) patch.elvCategorySource = raw.elvCategorySource;
  if (typeof raw.elvSmartRecommendations === 'boolean') {
    patch.elvSmartRecommendations = raw.elvSmartRecommendations;
  }
  if (typeof raw.elvXrayEnabled === 'boolean') patch.elvXrayEnabled = raw.elvXrayEnabled;
  if (typeof raw.elvLiveEnhance === 'boolean') patch.elvLiveEnhance = raw.elvLiveEnhance;
  if (typeof raw.elvVerifyRealQuality === 'boolean') {
    patch.elvVerifyRealQuality = raw.elvVerifyRealQuality;
  }

  return patch as PreferencesPatch;
}
