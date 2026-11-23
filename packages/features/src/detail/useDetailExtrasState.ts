import type { KeyEvent } from '@elv/focus-core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DetailTarget } from '../shared';
import type { DetailHeroFocusSlot } from './DetailHero';
import {
  cyclePrePlayOption,
  normalizePrePlayLang,
  PREPLAY_AUDIO_OPTIONS,
  PREPLAY_SUBTITLE_OPTIONS,
  SYNOPSIS_EXPAND_THRESHOLD,
} from './detail-preplay';

/** Options for {@link useDetailExtrasState}. */
export interface UseDetailExtrasStateOptions {
  readonly target: DetailTarget;
  readonly plot: string | null;
  readonly preferredAudioLang?: string;
  readonly preferredSubtitleLang?: string;
  readonly hasVersions?: boolean;
}

/** Local pre-play language selectors, synopsis sheet toggle, and derived TV focus slots for `DetailScreen`. */
export interface DetailExtrasState {
  readonly audioLang: string;
  readonly subtitleLang: string;
  readonly synopsisExpanded: boolean;
  readonly trimmedPlot: string;
  readonly canExpandSynopsis: boolean;
  readonly heroPlaySlots: readonly DetailHeroFocusSlot[];
  readonly castPeople: readonly string[];
  readonly cycleAudio: () => void;
  readonly cycleSubtitles: () => void;
  readonly toggleSynopsis: () => void;
  readonly dismissSynopsis: () => void;
  readonly interceptTvKey: (event: KeyEvent, fallback: (ev: KeyEvent) => boolean) => boolean;
}

/**
 * Manages pre-play audio/subtitle overrides, expandable synopsis sheet state, and derived hero/cast
 * focus slots for {@link DetailScreen}, resetting cleanly whenever the active title changes (`#398`).
 */
export function useDetailExtrasState({
  target,
  plot,
  preferredAudioLang,
  preferredSubtitleLang,
  hasVersions = false,
}: UseDetailExtrasStateOptions): DetailExtrasState {
  const [audioLang, setAudioLang] = useState(() =>
    normalizePrePlayLang(preferredAudioLang, PREPLAY_AUDIO_OPTIONS),
  );
  const [subtitleLang, setSubtitleLang] = useState(() =>
    normalizePrePlayLang(preferredSubtitleLang, PREPLAY_SUBTITLE_OPTIONS),
  );
  const [synopsisExpanded, setSynopsisExpanded] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset sheet & track overrides whenever opening a new title
  useEffect(() => {
    setSynopsisExpanded(false);
    setAudioLang(normalizePrePlayLang(preferredAudioLang, PREPLAY_AUDIO_OPTIONS));
    setSubtitleLang(normalizePrePlayLang(preferredSubtitleLang, PREPLAY_SUBTITLE_OPTIONS));
  }, [preferredAudioLang, preferredSubtitleLang, target.itemKey]);

  const cycleAudio = useCallback(
    () => setAudioLang((prev) => cyclePrePlayOption(PREPLAY_AUDIO_OPTIONS, prev)),
    [],
  );
  const cycleSubtitles = useCallback(
    () => setSubtitleLang((prev) => cyclePrePlayOption(PREPLAY_SUBTITLE_OPTIONS, prev)),
    [],
  );
  const toggleSynopsis = useCallback(() => setSynopsisExpanded((v) => !v), []);
  const dismissSynopsis = useCallback(() => setSynopsisExpanded(false), []);

  const trimmedPlot = plot?.trim() ?? '';
  const canExpandSynopsis = trimmedPlot.length >= SYNOPSIS_EXPAND_THRESHOLD;

  const heroPlaySlots = useMemo<readonly DetailHeroFocusSlot[]>(
    () => [
      'play',
      ...(hasVersions ? (['preplay-version'] as const) : []),
      'preplay-audio',
      'preplay-subtitles',
      ...(canExpandSynopsis ? (['synopsis'] as const) : []),
    ],
    [canExpandSynopsis, hasVersions],
  );

  const castPeople = useMemo<readonly string[]>(() => {
    const out: string[] = [];
    const dir = target.director?.trim();
    if (dir) out.push(dir);
    if (target.cast) {
      for (const m of target.cast) out.push(m.name);
    }
    return out;
  }, [target.cast, target.director]);

  const interceptTvKey = useCallback(
    (event: KeyEvent, fallback: (ev: KeyEvent) => boolean): boolean => {
      if (synopsisExpanded) {
        if (event.kind === 'press' && (event.key === 'back' || event.key === 'select')) {
          setSynopsisExpanded(false);
        }
        return true;
      }
      return fallback(event);
    },
    [synopsisExpanded],
  );

  return {
    audioLang,
    subtitleLang,
    synopsisExpanded,
    trimmedPlot,
    canExpandSynopsis,
    heroPlaySlots,
    castPeople,
    cycleAudio,
    cycleSubtitles,
    toggleSynopsis,
    dismissSynopsis,
    interceptTvKey,
  };
}
