import {
  extractLanguageCodeFromLabel,
  normalizeLanguageCode,
  type PreferencesPatch,
  type SubtitleModePref,
} from '@elv/domain';
import type { TrackInfo } from '@elv/playback';

const ISO_639_2_TO_1: Readonly<Record<string, string>> = {
  tur: 'tr',
  eng: 'en',
  deu: 'de',
  ger: 'de',
  fra: 'fr',
  fre: 'fr',
  spa: 'es',
  ita: 'it',
  rus: 'ru',
  ara: 'ar',
  por: 'pt',
  nld: 'nl',
  dut: 'nl',
  jpn: 'ja',
  kor: 'ko',
  zho: 'zh',
  chi: 'zh',
};

const UNDETERMINED_CODES = new Set(['und', 'mul', 'mis', 'zxx', 'unknown']);

/** Normalizes an ISO 639-1, ISO 639-2/B/T, or BCP-47 language tag to a canonical lowercase code. */
export function normalizeTrackLanguage(code: string | undefined): string {
  if (typeof code !== 'string') return '';
  const trimmed = code.trim();
  if (trimmed.length === 0) return '';
  const primary = trimmed.split(/[-_]/)[0]?.toLowerCase() ?? '';
  if (primary.length === 0 || UNDETERMINED_CODES.has(primary)) return '';
  return ISO_639_2_TO_1[primary] ?? primary;
}

/**
 * Selects the initial audio track ID matching `preferredLang` (normalized across ISO 639-1/2),
 * returning `undefined` when no preference is set or no track matches.
 */
export function chooseInitialAudioTrack(
  tracks: readonly TrackInfo[],
  preferredLang?: string,
): string | undefined {
  const target = normalizeTrackLanguage(preferredLang);
  if (target.length === 0 || tracks.length === 0) return undefined;
  const matches = tracks.filter((t) => normalizeTrackLanguage(t.language) === target);
  if (matches.length === 0) return undefined;
  return (matches.find((t) => t.isDefault === true) ?? matches[0])?.id;
}

/**
 * Computes the initial subtitle selection for a newly loaded item:
 * - `null`: explicitly disable subtitles (`subtitleMode === 'off'`)
 * - `string`: select that subtitle track ID
 * - `undefined`: leave engine default untouched
 */
export function chooseInitialSubtitleTrack(
  tracks: readonly TrackInfo[],
  opts: {
    readonly preferredLang?: string | undefined;
    readonly subtitleMode?: SubtitleModePref | undefined;
  },
): string | null | undefined {
  const mode = opts.subtitleMode ?? 'smart';
  if (mode === 'off') return null;
  if (tracks.length === 0) return undefined;

  const target = normalizeTrackLanguage(opts.preferredLang);
  if (mode === 'onlyForced') {
    if (target.length > 0) {
      const forcedMatch = tracks.find(
        (t) => t.forced === true && normalizeTrackLanguage(t.language) === target,
      );
      if (forcedMatch) return forcedMatch.id;
    }
    return null;
  }

  if (mode === 'default') {
    const def = tracks.find((t) => t.isDefault === true);
    return def?.id ?? null;
  }

  if (target.length > 0) {
    const matches = tracks.filter((t) => normalizeTrackLanguage(t.language) === target);
    if (matches.length > 0) {
      return (matches.find((t) => t.forced !== true) ?? matches[0])?.id;
    }
  }

  if (mode === 'always') {
    return (
      tracks.find((t) => t.isDefault === true && t.forced !== true) ??
      tracks.find((t) => t.forced !== true) ??
      tracks[0]
    )?.id;
  }

  return undefined;
}

/** Resolved per-item track preference inputs after combining global settings with `PlayTarget` overrides. */
export interface EffectiveTrackPrefs {
  readonly audioLang: string | undefined;
  readonly subtitleLang: string | undefined;
  readonly subtitleMode: SubtitleModePref;
}

/** Resolves the persistence scope key for per-item/per-series track preferences (`#208`). */
export function resolveTrackPreferenceScopeKey(target: {
  readonly itemKey: string;
  readonly seriesKey?: string | null | undefined;
}): string {
  const series = target.seriesKey?.trim();
  return series !== undefined && series.length > 0 ? series : target.itemKey;
}

/** Combines global player track preferences with optional per-target pre-play overrides (`#398`, `#401`). */
export function resolveEffectiveTrackPrefs(input: {
  readonly globalAudioLang?: string | undefined;
  readonly globalSubtitleLang?: string | undefined;
  readonly globalSubtitleMode?: SubtitleModePref | undefined;
  readonly targetAudioLang?: string | undefined;
  readonly targetSubtitleLang?: string | undefined;
}): EffectiveTrackPrefs {
  const targetAudio = input.targetAudioLang?.trim() ?? '';
  const targetSub = input.targetSubtitleLang?.trim() ?? '';
  const baseMode = input.globalSubtitleMode ?? 'smart';
  const audioLang = targetAudio.length > 0 ? targetAudio : input.globalAudioLang;
  const subtitleLang =
    targetSub.length > 0 && targetSub.toLowerCase() !== 'off'
      ? targetSub
      : input.globalSubtitleLang;
  const subtitleMode: SubtitleModePref =
    targetSub.toLowerCase() === 'off'
      ? 'off'
      : targetSub.length > 0 && baseMode === 'off'
        ? 'smart'
        : baseMode;
  return { audioLang, subtitleLang, subtitleMode };
}

const MAX_PREFERRED_LANGUAGES = 5;

function resolveCanonicalTrackLang(track: TrackInfo | undefined): string {
  if (track === undefined) return '';
  const fromCode = normalizeLanguageCode(track.language) ?? normalizeTrackLanguage(track.language);
  if (fromCode.length > 0) return fromCode;
  return extractLanguageCodeFromLabel(track.label) ?? '';
}

function promoteLanguage(lang: string, existing: readonly string[] | undefined): readonly string[] {
  const deduped: string[] = [lang];
  if (existing !== undefined) {
    for (const raw of existing) {
      const normalized = normalizeLanguageCode(raw) ?? normalizeTrackLanguage(raw);
      if (normalized.length > 0 && !deduped.includes(normalized)) {
        deduped.push(normalized);
        if (deduped.length >= MAX_PREFERRED_LANGUAGES) break;
      }
    }
  }
  return deduped;
}

/** Input for {@link computeGlobalTrackLanguagePatch}. */
export type GlobalTrackLanguagePatchInput =
  | {
      readonly kind: 'audio';
      readonly track: TrackInfo | undefined;
      readonly existingAudioLanguages?: readonly string[] | undefined;
    }
  | {
      readonly kind: 'subtitle';
      readonly track: TrackInfo | null | undefined;
      readonly activeAudioTrack?: TrackInfo | undefined;
      readonly existingSubtitleLanguages?: readonly string[] | undefined;
      readonly currentSubtitleMode?: SubtitleModePref | undefined;
      readonly mediaKind: 'live' | 'vod';
    };

/**
 * Computes a sticky global {@link PreferencesPatch} when the user manually picks an audio or
 * subtitle track inside the player, so subsequent movies and series automatically inherit the
 * user's preferred language pairing.
 */
export function computeGlobalTrackLanguagePatch(
  input: GlobalTrackLanguagePatchInput,
): PreferencesPatch | null {
  if (input.kind === 'audio') {
    const lang = resolveCanonicalTrackLang(input.track);
    if (lang.length === 0) return null;
    return {
      preferredAudioLang: lang,
      preferredAudioLanguages: promoteLanguage(lang, input.existingAudioLanguages),
      preferDefaultAudioTrack: false,
    };
  }

  if (input.track === null) {
    return input.mediaKind === 'vod' ? { subtitleMode: 'off' } : null;
  }

  const lang = resolveCanonicalTrackLang(input.track);
  if (lang.length === 0) return null;

  const nextSubtitleLanguages = promoteLanguage(lang, input.existingSubtitleLanguages);
  const activeAudioLang = resolveCanonicalTrackLang(input.activeAudioTrack);
  let nextMode: SubtitleModePref | undefined;
  if (activeAudioLang.length > 0 && nextSubtitleLanguages.includes(activeAudioLang)) {
    nextMode = 'always';
  } else if (input.currentSubtitleMode === 'off') {
    nextMode = 'smart';
  }

  return {
    preferredSubtitleLang: lang,
    preferredSubtitleLanguages: nextSubtitleLanguages,
    ...(nextMode !== undefined ? { subtitleMode: nextMode } : {}),
  };
}
