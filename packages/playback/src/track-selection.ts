import {
  extractLanguageCodeFromLabel,
  normalizeLanguageCode,
  type SubtitleModePref,
} from '@elv/domain';
import type { MediaKind, MediaTracks, TrackInfo } from './engine';

/** Explicit track override by track ID (for session or target overrides). */
export interface TrackSelectionOverride {
  readonly audioId?: string;
  readonly subtitleId?: string | null;
}

/** Per-item persisted track preference (`#208`), evaluated independently for audio and subtitles. */
export interface PersistedTrackSelectionPref {
  readonly audioLang?: string | null;
  readonly audioLabel?: string | null;
  readonly subLang?: string | null;
  readonly subLabel?: string | null;
  readonly subDisabled?: boolean;
}

/** Profile-level language and subtitle activation rules (`#393`). */
export interface ProfileTrackRules {
  readonly preferredAudioLanguages?: readonly string[];
  readonly preferDefaultAudioTrack?: boolean;
  readonly preferredSubtitleLanguages?: readonly string[];
  readonly subtitleMode?: SubtitleModePref;
  /** Optional app UI locale (e.g. `'tr'` or `'tr-TR'`) used when preferred audio & subtitle lists are empty. */
  readonly fallbackLocale?: string;
}

/** Combined rule hierarchy for {@link resolveInitialTrackSelection}. */
export interface TrackSelectionRules {
  /** Optional media kind; live streams default subtitles off unless explicitly overridden per channel. */
  readonly mediaKind?: MediaKind;
  readonly sessionOverride?: TrackSelectionOverride;
  readonly targetOverride?: TrackSelectionOverride;
  readonly persistedItemPref?: PersistedTrackSelectionPref | null;
  readonly profileRules?: ProfileTrackRules;
}

/** Resolved initial track IDs; explicit `subtitleId: null` turns subtitles off. */
export interface InitialTrackSelection {
  readonly audioId?: string;
  readonly subtitleId?: string | null;
}

function trackLang(track: TrackInfo | undefined): string | undefined {
  if (track === undefined) return undefined;
  return normalizeLanguageCode(track.language) ?? extractLanguageCodeFromLabel(track.label);
}

function normalizeLangList(langs: readonly string[] | undefined): readonly string[] {
  if (!langs || langs.length === 0) return [];
  const out: string[] = [];
  for (const raw of langs) {
    const code = normalizeLanguageCode(raw);
    if (code !== undefined && !out.includes(code)) out.push(code);
  }
  return out;
}

function findById(candidates: readonly TrackInfo[], id: string | undefined): TrackInfo | undefined {
  if (id === undefined) return undefined;
  return candidates.find((t) => t.id === id);
}

function findByLangAndLabel(
  candidates: readonly TrackInfo[],
  lang: string | null | undefined,
  label: string | null | undefined,
): TrackInfo | undefined {
  const normLang = normalizeLanguageCode(lang);
  const normLabel = typeof label === 'string' && label.trim().length > 0 ? label.trim() : undefined;
  if (normLang !== undefined && normLabel !== undefined) {
    const both = candidates.find((t) => trackLang(t) === normLang && t.label?.trim() === normLabel);
    if (both) return both;
  }
  if (normLang !== undefined) {
    const byLang = candidates.find((t) => trackLang(t) === normLang);
    if (byLang) return byLang;
  }
  if (normLabel !== undefined) {
    const byLabel = candidates.find((t) => t.label?.trim() === normLabel);
    if (byLabel) return byLabel;
  }
  return undefined;
}

function findByPreferredLanguages(
  candidates: readonly TrackInfo[],
  preferred: readonly string[],
  predicate: (track: TrackInfo) => boolean,
  preferDefault: boolean,
): TrackInfo | undefined {
  for (const lang of preferred) {
    const matches = candidates.filter((t) => trackLang(t) === lang && predicate(t));
    if (matches.length === 0) continue;
    if (preferDefault) {
      const def = matches.find((t) => t.isDefault === true);
      if (def) return def;
    }
    return matches[0];
  }
  return undefined;
}

function resolveAudioTrack(tracks: MediaTracks, rules: TrackSelectionRules): string | undefined {
  if (tracks.audio.length === 0) return undefined;

  const sessionMatch = findById(tracks.audio, rules.sessionOverride?.audioId);
  if (sessionMatch) return sessionMatch.id;

  const targetMatch = findById(tracks.audio, rules.targetOverride?.audioId);
  if (targetMatch) return targetMatch.id;

  const persisted = rules.persistedItemPref;
  if (persisted) {
    const persistedMatch = findByLangAndLabel(
      tracks.audio,
      persisted.audioLang,
      persisted.audioLabel,
    );
    if (persistedMatch) return persistedMatch.id;
  }

  const profile = rules.profileRules;
  const preferDefault = profile?.preferDefaultAudioTrack !== false;
  const preferredAudio = normalizeLangList(profile?.preferredAudioLanguages);
  const langMatch = findByPreferredLanguages(
    tracks.audio,
    preferredAudio,
    () => true,
    preferDefault,
  );
  if (langMatch) return langMatch.id;

  if (preferDefault) {
    const defaultTrack = tracks.audio.find((t) => t.isDefault === true);
    if (defaultTrack) return defaultTrack.id;
  }
  return undefined;
}

function resolveEffectiveAudioLang(
  tracks: MediaTracks,
  chosenAudioId: string | undefined,
): string | undefined {
  const effective =
    findById(tracks.audio, chosenAudioId) ??
    findById(tracks.audio, tracks.selectedAudioId ?? undefined) ??
    tracks.audio.find((t) => t.isDefault === true) ??
    tracks.audio[0];
  return trackLang(effective);
}

function resolveSubtitleTrack(
  tracks: MediaTracks,
  rules: TrackSelectionRules,
  effectiveAudioLang: string | undefined,
): string | null {
  if (rules.sessionOverride?.subtitleId !== undefined) {
    if (rules.sessionOverride.subtitleId === null) return null;
    const match = findById(tracks.subtitles, rules.sessionOverride.subtitleId);
    if (match) return match.id;
  }

  if (rules.targetOverride?.subtitleId !== undefined) {
    if (rules.targetOverride.subtitleId === null) return null;
    const match = findById(tracks.subtitles, rules.targetOverride.subtitleId);
    if (match) return match.id;
  }

  const persisted = rules.persistedItemPref;
  if (persisted) {
    if (persisted.subDisabled === true) return null;
    const persistedMatch = findByLangAndLabel(
      tracks.subtitles,
      persisted.subLang,
      persisted.subLabel,
    );
    if (persistedMatch) return persistedMatch.id;
  }

  if (rules.mediaKind === 'live') return null;

  const profile = rules.profileRules;
  const mode: SubtitleModePref = profile?.subtitleMode ?? 'smart';
  if (mode === 'off' || tracks.subtitles.length === 0) return null;

  const prefSubs = normalizeLangList(profile?.preferredSubtitleLanguages);
  const prefAudio = normalizeLangList(profile?.preferredAudioLanguages);
  const fallbackLang =
    prefSubs.length === 0 && prefAudio.length === 0
      ? normalizeLanguageCode(profile?.fallbackLocale)
      : undefined;
  const effectivePrefSubs =
    prefSubs.length > 0 ? prefSubs : fallbackLang !== undefined ? [fallbackLang] : [];

  if (mode === 'onlyForced') {
    const forcedPref = findByPreferredLanguages(
      tracks.subtitles,
      effectivePrefSubs,
      (t) => t.forced === true,
      true,
    );
    if (forcedPref) return forcedPref.id;
    if (effectiveAudioLang !== undefined) {
      const forcedAudio = tracks.subtitles.find(
        (t) => t.forced === true && trackLang(t) === effectiveAudioLang,
      );
      if (forcedAudio) return forcedAudio.id;
    }
    return null;
  }

  if (mode === 'always') {
    const fullPref = findByPreferredLanguages(
      tracks.subtitles,
      effectivePrefSubs,
      (t) => t.forced !== true,
      true,
    );
    if (fullPref) return fullPref.id;
    const anyPref = findByPreferredLanguages(tracks.subtitles, effectivePrefSubs, () => true, true);
    if (anyPref) return anyPref.id;
    const def = tracks.subtitles.find((t) => t.isDefault === true);
    return def?.id ?? tracks.subtitles[0]?.id ?? null;
  }

  if (mode === 'default') {
    const defPref = findByPreferredLanguages(
      tracks.subtitles,
      prefSubs,
      (t) => t.isDefault === true,
      true,
    );
    if (defPref) return defPref.id;
    const defAny = tracks.subtitles.find((t) => t.isDefault === true);
    if (defAny) return defAny.id;
    if (effectiveAudioLang !== undefined) {
      const forcedAudio = tracks.subtitles.find(
        (t) => t.forced === true && trackLang(t) === effectiveAudioLang,
      );
      if (forcedAudio) return forcedAudio.id;
    }
    return null;
  }

  // mode === 'smart'
  const understoodLangs =
    prefSubs.length > 0
      ? prefSubs
      : prefAudio.length > 0
        ? prefAudio
        : fallbackLang !== undefined
          ? [fallbackLang]
          : [];
  const audioUnderstood =
    effectiveAudioLang !== undefined &&
    (understoodLangs.length === 0 || understoodLangs.includes(effectiveAudioLang));

  if (audioUnderstood) {
    const forcedForAudio = tracks.subtitles.find(
      (t) => t.forced === true && trackLang(t) === effectiveAudioLang,
    );
    return forcedForAudio?.id ?? null;
  }

  const fullPref = findByPreferredLanguages(
    tracks.subtitles,
    understoodLangs,
    (t) => t.forced !== true,
    true,
  );
  if (fullPref) return fullPref.id;
  const anyPref = findByPreferredLanguages(tracks.subtitles, understoodLangs, () => true, true);
  return anyPref?.id ?? null;
}

/**
 * Deterministically resolves initial audio and subtitle tracks using the Wave C1 precedence chain:
 * `sessionOverride` -> `targetOverride` -> `persistedItemPref` (`#208`) -> `profileRules` (`#393`).
 * Always returns explicit `subtitleId: null` when subtitles should be disabled.
 */
export function resolveInitialTrackSelection(
  tracks: MediaTracks,
  rules: TrackSelectionRules,
): InitialTrackSelection {
  const audioId = resolveAudioTrack(tracks, rules);
  const effectiveAudioLang = resolveEffectiveAudioLang(tracks, audioId);
  const subtitleId = resolveSubtitleTrack(tracks, rules, effectiveAudioLang);
  return {
    ...(audioId === undefined ? {} : { audioId }),
    subtitleId,
  };
}
