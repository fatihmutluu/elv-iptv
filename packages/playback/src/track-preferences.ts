import { normalizeLanguageCode, sameLanguageCode } from '@elv/domain';
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
}

interface TrackPreferences {
  reset(): void;
  beginReload(): void;
  loadOptions(base?: LoadOptions): LoadOptions;
  selectAudio(id: string, tracks: MediaTracks, loaded: boolean): void;
  selectSubtitle(id: string | null, tracks: MediaTracks, loaded: boolean): void;
  reconcile(tracks: MediaTracks): ReconciledTracks;
}

function toChoice(id: string, matched: TrackInfo | undefined, previous?: TrackChoice): TrackChoice {
  const rawLang = matched?.language ?? (previous?.id === id ? previous.language : undefined);
  const language = normalizeLanguageCode(rawLang);
  const label = matched?.label ?? (previous?.id === id ? previous.label : undefined);
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
    wanted.language === undefined || sameLanguageCode(exact?.language, wanted.language);
  const exactLabelOk =
    wanted.label === undefined || exact?.label === undefined || exact.label === wanted.label;
  if (exact && exactLangOk && exactLabelOk) {
    return exact;
  }
  if (wanted.language !== undefined && wanted.label !== undefined) {
    const both = candidates.find(
      (t) => sameLanguageCode(t.language, wanted.language) && t.label === wanted.label,
    );
    if (both) return both;
  }
  if (wanted.language !== undefined) {
    const byLang = candidates.find((t) => sameLanguageCode(t.language, wanted.language));
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
  let audioReapplied = false;
  let subtitleReapplied = false;

  return {
    reset() {
      audio = undefined;
      subtitle = { kind: 'default' };
      audioReapplied = false;
      subtitleReapplied = false;
    },

    beginReload() {
      audioReapplied = false;
      subtitleReapplied = false;
    },

    loadOptions(base) {
      return {
        ...base,
        ...(audio === undefined ? {} : { audioTrackId: audio.id }),
        ...(subtitle.kind === 'default'
          ? {}
          : { subtitleTrackId: subtitle.kind === 'off' ? null : subtitle.choice.id }),
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

    reconcile(tracks) {
      let audioTrackId: string | undefined;
      let subtitleTrackId: string | null | undefined;

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

      return {
        ...(audioTrackId === undefined ? {} : { audioTrackId }),
        ...(subtitleTrackId === undefined ? {} : { subtitleTrackId }),
      };
    },
  };
}
