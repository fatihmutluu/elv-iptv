import { extractLanguageCodeFromLabel, normalizeLanguageCode, sameLanguageCode } from '@elv/domain';
import type { LoadOptions, MediaTracks, TrackInfo } from './engine';

interface TrackChoice {
  readonly id: string;
  readonly language?: string;
  readonly label?: string;
}

type SubtitleChoice =
  | { readonly kind: 'default' }
  | { readonly kind: 'off' }
  | { readonly kind: 'selected'; readonly choice: TrackChoice };

interface ReconciledTracks {
  readonly audioTrackId?: string;
  readonly subtitleTrackId?: string | null;
  readonly secondarySubtitleTrackId?: string | null;
}

interface TrackPreferences {
  reset(): void;
  beginReload(): void;
  loadOptions(base?: LoadOptions): LoadOptions;
  selectAudio(id: string, tracks: MediaTracks, loaded: boolean): void;
  selectSubtitle(id: string | null, tracks: MediaTracks, loaded: boolean): void;
  selectSecondarySubtitle(id: string | null, tracks: MediaTracks, loaded: boolean): void;
  currentSubtitleId(): string | null | undefined;
  currentSecondarySubtitleId(): string | null | undefined;
  reconcile(tracks: MediaTracks): ReconciledTracks;
}

function resolveTrackLanguage(
  track: Pick<TrackInfo, 'language' | 'label'> | undefined,
): string | undefined {
  if (track === undefined) return undefined;
  return normalizeLanguageCode(track.language) ?? extractLanguageCodeFromLabel(track.label);
}

function toChoice(id: string, matched: TrackInfo | undefined, previous?: TrackChoice): TrackChoice {
  const prev = previous?.id === id ? previous : undefined;
  const language = resolveTrackLanguage(matched) ?? resolveTrackLanguage(prev);
  const label = matched?.label ?? prev?.label;
  return {
    id,
    ...(language === undefined ? {} : { language }),
    ...(label === undefined ? {} : { label }),
  };
}

function resolveChoice(
  candidates: readonly TrackInfo[],
  wanted: TrackChoice,
): TrackInfo | undefined {
  const exact = candidates.find((t) => t.id === wanted.id);
  const exactLangOk =
    wanted.language === undefined || sameLanguageCode(resolveTrackLanguage(exact), wanted.language);
  const exactLabelOk =
    wanted.label === undefined || exact?.label === undefined || exact.label === wanted.label;
  if (exact && exactLangOk && exactLabelOk) {
    return exact;
  }
  if (wanted.language !== undefined && wanted.label !== undefined) {
    const both = candidates.find(
      (t) => sameLanguageCode(resolveTrackLanguage(t), wanted.language) && t.label === wanted.label,
    );
    if (both) return both;
  }
  if (wanted.language !== undefined) {
    const byLang = candidates.find((t) =>
      sameLanguageCode(resolveTrackLanguage(t), wanted.language),
    );
    if (byLang) return byLang;
  }
  if (wanted.label !== undefined) {
    const byLabel = candidates.find((t) => t.label === wanted.label);
    if (byLabel) return byLabel;
  }
  return exact;
}

/**
 * @internal Tracks active user audio/subtitle choices across reloads, reconciling shifted stream IDs
 * by canonical `(language, label)` with the same priority order as the native engines.
 */
export function createTrackPreferences(): TrackPreferences {
  let audio: TrackChoice | undefined;
  let subtitle: SubtitleChoice = { kind: 'default' };
  let secondarySubtitle: SubtitleChoice = { kind: 'default' };
  let audioReapplied = false;
  let subtitleReapplied = false;
  let secondarySubtitleReapplied = false;

  return {
    reset() {
      audio = undefined;
      subtitle = { kind: 'default' };
      secondarySubtitle = { kind: 'default' };
      audioReapplied = false;
      subtitleReapplied = false;
      secondarySubtitleReapplied = false;
    },

    beginReload() {
      audioReapplied = false;
      subtitleReapplied = false;
      secondarySubtitleReapplied = false;
    },

    loadOptions(base) {
      const primarySubId = subtitle.kind === 'selected' ? subtitle.choice.id : null;
      const secondaryOption =
        secondarySubtitle.kind === 'default'
          ? {}
          : secondarySubtitle.kind === 'off' || secondarySubtitle.choice.id === primarySubId
            ? { secondarySubtitleTrackId: null }
            : { secondarySubtitleTrackId: secondarySubtitle.choice.id };
      return {
        ...base,
        ...(audio === undefined ? {} : { audioTrackId: audio.id }),
        ...(subtitle.kind === 'default'
          ? {}
          : { subtitleTrackId: subtitle.kind === 'off' ? null : subtitle.choice.id }),
        ...secondaryOption,
      };
    },

    selectAudio(id, tracks, loaded) {
      const matched = tracks.audio.find((t) => t.id === id);
      audio = toChoice(id, matched, audio);
      if (loaded) audioReapplied = true;
    },

    selectSubtitle(id, tracks, loaded) {
      if (id === null) {
        subtitle = { kind: 'off' };
      } else {
        const matched = tracks.subtitles.find((t) => t.id === id);
        const prev = subtitle.kind === 'selected' ? subtitle.choice : undefined;
        subtitle = { kind: 'selected', choice: toChoice(id, matched, prev) };
      }
      if (loaded) subtitleReapplied = true;
    },

    selectSecondarySubtitle(id, tracks, loaded) {
      if (id === null) {
        secondarySubtitle = { kind: 'off' };
      } else {
        const matched = tracks.subtitles.find((t) => t.id === id);
        const prev = secondarySubtitle.kind === 'selected' ? secondarySubtitle.choice : undefined;
        secondarySubtitle = { kind: 'selected', choice: toChoice(id, matched, prev) };
      }
      if (loaded) secondarySubtitleReapplied = true;
    },

    currentSubtitleId() {
      if (subtitle.kind === 'default') return undefined;
      return subtitle.kind === 'off' ? null : subtitle.choice.id;
    },

    currentSecondarySubtitleId() {
      if (secondarySubtitle.kind === 'default') return undefined;
      return secondarySubtitle.kind === 'off' ? null : secondarySubtitle.choice.id;
    },

    reconcile(tracks) {
      let audioTrackId: string | undefined;
      let subtitleTrackId: string | null | undefined;
      let secondarySubtitleTrackId: string | null | undefined;

      if (audio !== undefined) {
        if (audioReapplied) {
          if (audio.language === undefined && audio.label === undefined) {
            const currentId = audio.id;
            const exact = tracks.audio.find((t) => t.id === currentId);
            if (exact) audio = toChoice(exact.id, exact, audio);
          }
        } else {
          const resolved = resolveChoice(tracks.audio, audio);
          if (resolved !== undefined) {
            audio = toChoice(resolved.id, resolved, audio);
            audioReapplied = true;
            if (tracks.selectedAudioId !== resolved.id) audioTrackId = resolved.id;
          }
        }
      }

      if (subtitle.kind === 'off') {
        if (!subtitleReapplied) {
          if (tracks.selectedSubtitleId !== null) {
            subtitleReapplied = true;
            subtitleTrackId = null;
          } else if (tracks.subtitles.length > 0) {
            subtitleReapplied = true;
          }
        }
      } else if (subtitle.kind === 'selected') {
        if (subtitleReapplied) {
          if (subtitle.choice.language === undefined && subtitle.choice.label === undefined) {
            const currentId = subtitle.choice.id;
            const exact = tracks.subtitles.find((t) => t.id === currentId);
            if (exact) {
              subtitle = { kind: 'selected', choice: toChoice(exact.id, exact, subtitle.choice) };
            }
          }
        } else {
          const resolved = resolveChoice(tracks.subtitles, subtitle.choice);
          if (resolved !== undefined) {
            subtitle = {
              kind: 'selected',
              choice: toChoice(resolved.id, resolved, subtitle.choice),
            };
            subtitleReapplied = true;
            if (tracks.selectedSubtitleId !== resolved.id) subtitleTrackId = resolved.id;
          }
        }
      }

      const effectivePrimaryId =
        subtitleTrackId !== undefined ? subtitleTrackId : tracks.selectedSubtitleId;

      if (secondarySubtitle.kind === 'off') {
        if (!secondarySubtitleReapplied) {
          if (
            tracks.selectedSecondarySubtitleId !== null &&
            tracks.selectedSecondarySubtitleId !== undefined
          ) {
            secondarySubtitleReapplied = true;
            secondarySubtitleTrackId = null;
          } else if (tracks.subtitles.length > 0) {
            secondarySubtitleReapplied = true;
          }
        }
      } else if (secondarySubtitle.kind === 'selected') {
        if (secondarySubtitleReapplied) {
          if (
            secondarySubtitle.choice.language === undefined &&
            secondarySubtitle.choice.label === undefined
          ) {
            const currentId = secondarySubtitle.choice.id;
            const exact = tracks.subtitles.find((t) => t.id === currentId);
            if (exact) {
              secondarySubtitle = {
                kind: 'selected',
                choice: toChoice(exact.id, exact, secondarySubtitle.choice),
              };
            }
          }
        } else {
          const candidates =
            effectivePrimaryId === null
              ? tracks.subtitles
              : tracks.subtitles.filter((t) => t.id !== effectivePrimaryId);
          const resolved = resolveChoice(candidates, secondarySubtitle.choice);
          if (resolved !== undefined) {
            secondarySubtitle = {
              kind: 'selected',
              choice: toChoice(resolved.id, resolved, secondarySubtitle.choice),
            };
            secondarySubtitleReapplied = true;
            if (tracks.selectedSecondarySubtitleId !== resolved.id) {
              secondarySubtitleTrackId = resolved.id;
            }
          } else if (effectivePrimaryId !== null) {
            const colliding = resolveChoice(tracks.subtitles, secondarySubtitle.choice);
            if (colliding !== undefined && colliding.id === effectivePrimaryId) {
              secondarySubtitle = { kind: 'off' };
              secondarySubtitleReapplied = true;
              if (
                tracks.selectedSecondarySubtitleId !== null &&
                tracks.selectedSecondarySubtitleId !== undefined
              ) {
                secondarySubtitleTrackId = null;
              }
            }
          }
        }
      }

      return {
        ...(audioTrackId === undefined ? {} : { audioTrackId }),
        ...(subtitleTrackId === undefined ? {} : { subtitleTrackId }),
        ...(secondarySubtitleTrackId === undefined ? {} : { secondarySubtitleTrackId }),
      };
    },
  };
}
