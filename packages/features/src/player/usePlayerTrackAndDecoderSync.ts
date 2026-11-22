import type { AndroidDecoderMode, SubtitleModePref } from '@elv/domain';
import type { MediaTracks, PlaybackService } from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';
import {
  chooseInitialAudioTrack,
  chooseInitialSubtitleTrack,
  resolveEffectiveTrackPrefs,
} from './track-preferences';

/**
 * Applies preferred initial audio & subtitle tracks once per active item (`#401`).
 */
export function useInitialTrackSelection(params: {
  readonly activeService: PlaybackService | null;
  readonly activeTarget: PlayTarget;
  readonly tracks: MediaTracks;
  readonly preferredAudioLang?: string | undefined;
  readonly preferredSubtitleLang?: string | undefined;
  readonly subtitleMode: SubtitleModePref;
}): void {
  const {
    activeService,
    activeTarget,
    tracks,
    preferredAudioLang,
    preferredSubtitleLang,
    subtitleMode,
  } = params;
  const appliedAudioItemRef = useRef<string | null>(null);
  const appliedSubtitleItemRef = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset applied track refs on item change
  useEffect(() => {
    appliedAudioItemRef.current = null;
    appliedSubtitleItemRef.current = null;
  }, [activeTarget.itemKey]);

  const targetTrackPrefs = activeTarget as PlayTarget & {
    readonly preferredAudioLang?: string;
    readonly preferredSubtitleLang?: string;
  };
  const effectiveTracks = resolveEffectiveTrackPrefs({
    globalAudioLang: preferredAudioLang,
    globalSubtitleLang: preferredSubtitleLang,
    globalSubtitleMode: subtitleMode,
    targetAudioLang: targetTrackPrefs.preferredAudioLang,
    targetSubtitleLang: targetTrackPrefs.preferredSubtitleLang,
  });

  useEffect(() => {
    if (activeService === null) return;
    if (appliedAudioItemRef.current !== activeTarget.itemKey && tracks.audio.length > 0) {
      appliedAudioItemRef.current = activeTarget.itemKey;
      const chosenAudio = chooseInitialAudioTrack(tracks.audio, effectiveTracks.audioLang);
      if (chosenAudio !== undefined && chosenAudio !== tracks.selectedAudioId) {
        activeService.selectAudioTrack(chosenAudio);
      }
    }
    if (
      appliedSubtitleItemRef.current !== activeTarget.itemKey &&
      (tracks.subtitles.length > 0 || tracks.selectedSubtitleId !== null)
    ) {
      appliedSubtitleItemRef.current = activeTarget.itemKey;
      const chosenSubtitle = chooseInitialSubtitleTrack(tracks.subtitles, {
        preferredLang: effectiveTracks.subtitleLang,
        subtitleMode: effectiveTracks.subtitleMode,
      });
      if (chosenSubtitle !== undefined && chosenSubtitle !== tracks.selectedSubtitleId) {
        activeService.selectSubtitleTrack(chosenSubtitle);
      }
    }
  }, [
    activeService,
    activeTarget.itemKey,
    effectiveTracks.audioLang,
    effectiveTracks.subtitleLang,
    effectiveTracks.subtitleMode,
    tracks,
  ]);
}

/**
 * Syncs Android Media3 video decoder preference with active playback reload (`#411`).
 */
export function useAndroidDecoderModeSync(params: {
  readonly androidDecoderMode?: AndroidDecoderMode | undefined;
  readonly onSelectAndroidDecoderMode?: ((mode: AndroidDecoderMode) => void) | undefined;
  readonly reloadActiveTarget: () => void;
}): {
  readonly decoderModeRef: MutableRefObject<AndroidDecoderMode | undefined>;
  readonly activeDecoderMode: AndroidDecoderMode | undefined;
  readonly showAndroidDecoder: boolean;
  readonly handleSelectAndroidDecoderMode: (mode: AndroidDecoderMode) => void;
} {
  const { androidDecoderMode, onSelectAndroidDecoderMode, reloadActiveTarget } = params;
  const [activeDecoderMode, setActiveDecoderMode] = useState<AndroidDecoderMode | undefined>(
    androidDecoderMode,
  );
  const decoderModeRef = useRef<AndroidDecoderMode | undefined>(androidDecoderMode);
  useEffect(() => {
    setActiveDecoderMode(androidDecoderMode);
    decoderModeRef.current = androidDecoderMode;
  }, [androidDecoderMode]);

  const showAndroidDecoder =
    activeDecoderMode !== undefined && onSelectAndroidDecoderMode !== undefined;
  const handleSelectAndroidDecoderMode = useCallback(
    (mode: AndroidDecoderMode) => {
      onSelectAndroidDecoderMode?.(mode);
      if (mode === decoderModeRef.current) return;
      decoderModeRef.current = mode;
      setActiveDecoderMode(mode);
      reloadActiveTarget();
    },
    [onSelectAndroidDecoderMode, reloadActiveTarget],
  );

  return {
    decoderModeRef,
    activeDecoderMode,
    showAndroidDecoder,
    handleSelectAndroidDecoderMode,
  };
}
