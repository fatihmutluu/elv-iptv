import type { CatalogService, PersistedTrackPreference } from '@elv/data';
import type { AndroidDecoderMode, SubtitleModePref } from '@elv/domain';
import {
  type MediaTracks,
  type PlaybackService,
  resolveInitialTrackSelection,
} from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';
import type { VideoResizeMode } from '../ports/video-host';
import {
  chooseInitialAudioTrack,
  chooseInitialSubtitleTrack,
  resolveEffectiveTrackPrefs,
  resolveTrackPreferenceScopeKey,
} from './track-preferences';

/**
 * Hydrates per-item/series persisted track preferences (`#208`) and applies deterministic initial
 * audio & subtitle track selection (`#393` + `#208`) once per active item.
 */
export function useInitialTrackSelection(params: {
  readonly activeService: PlaybackService | null;
  readonly activeTarget: PlayTarget;
  readonly tracks: MediaTracks;
  readonly catalog?: Partial<Pick<CatalogService, 'getTrackPreference'>> | undefined;
  readonly preferredAudioLang?: string | undefined;
  readonly preferredSubtitleLang?: string | undefined;
  readonly preferredAudioLanguages?: readonly string[] | undefined;
  readonly preferredSubtitleLanguages?: readonly string[] | undefined;
  readonly preferDefaultAudioTrack?: boolean | undefined;
  readonly subtitleMode: SubtitleModePref;
  readonly onHydratedResizeMode?: ((mode: VideoResizeMode) => void) | undefined;
}): void {
  const {
    activeService,
    activeTarget,
    tracks,
    catalog,
    preferredAudioLang,
    preferredSubtitleLang,
    preferredAudioLanguages,
    preferredSubtitleLanguages,
    preferDefaultAudioTrack = true,
    subtitleMode,
    onHydratedResizeMode,
  } = params;
  const appliedAudioItemRef = useRef<string | null>(null);
  const appliedSubtitleItemRef = useRef<string | null>(null);
  const onHydratedResizeModeRef = useRef(onHydratedResizeMode);
  onHydratedResizeModeRef.current = onHydratedResizeMode;

  const scopeKey = resolveTrackPreferenceScopeKey(activeTarget);
  const hasPersistedStore = catalog?.getTrackPreference !== undefined;

  const [persistedState, setPersistedState] = useState<{
    readonly itemKey: string;
    readonly ready: boolean;
    readonly pref: PersistedTrackPreference | null;
  }>(() => ({
    itemKey: activeTarget.itemKey,
    ready: !hasPersistedStore,
    pref: null,
  }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset applied track refs on item change
  useEffect(() => {
    appliedAudioItemRef.current = null;
    appliedSubtitleItemRef.current = null;
  }, [activeTarget.itemKey]);

  useEffect(() => {
    const getPref = catalog?.getTrackPreference;
    if (getPref === undefined) {
      setPersistedState({ itemKey: activeTarget.itemKey, ready: true, pref: null });
      return;
    }
    let cancelled = false;
    setPersistedState({ itemKey: activeTarget.itemKey, ready: false, pref: null });
    void Promise.resolve(getPref(scopeKey))
      .then((pref) => {
        if (cancelled) return;
        setPersistedState({ itemKey: activeTarget.itemKey, ready: true, pref: pref ?? null });
        if (pref?.resizeMode) onHydratedResizeModeRef.current?.(pref.resizeMode);
      })
      .catch(() => {
        if (cancelled) return;
        setPersistedState({ itemKey: activeTarget.itemKey, ready: true, pref: null });
      });
    return () => {
      cancelled = true;
    };
  }, [activeTarget.itemKey, catalog?.getTrackPreference, scopeKey]);

  const effectiveAudioLangs =
    preferredAudioLanguages && preferredAudioLanguages.length > 0
      ? preferredAudioLanguages
      : preferredAudioLang && preferredAudioLang.trim().length > 0
        ? [preferredAudioLang.trim()]
        : [];
  const effectiveSubLangs =
    preferredSubtitleLanguages && preferredSubtitleLanguages.length > 0
      ? preferredSubtitleLanguages
      : preferredSubtitleLang && preferredSubtitleLang.trim().length > 0
        ? [preferredSubtitleLang.trim()]
        : [];

  const targetAudioLang = activeTarget.preferredAudioLang?.trim() ?? '';
  const targetSubLang = activeTarget.preferredSubtitleLang?.trim() ?? '';

  const prefReady =
    !hasPersistedStore || (persistedState.itemKey === activeTarget.itemKey && persistedState.ready);
  const persistedPref =
    persistedState.itemKey === activeTarget.itemKey ? persistedState.pref : null;

  useEffect(() => {
    if (activeService === null || !prefReady) return;

    const targetAudioId =
      targetAudioLang.length > 0
        ? chooseInitialAudioTrack(tracks.audio, targetAudioLang)
        : undefined;
    const targetSubOverride: string | null | undefined =
      targetSubLang.toLowerCase() === 'off'
        ? null
        : targetSubLang.length > 0
          ? chooseInitialSubtitleTrack(tracks.subtitles, {
              preferredLang: targetSubLang,
              subtitleMode: 'always',
            })
          : undefined;

    const effective = resolveEffectiveTrackPrefs({
      globalAudioLang: effectiveAudioLangs[0],
      globalSubtitleLang: effectiveSubLangs[0],
      globalSubtitleMode: subtitleMode,
      targetAudioLang: targetAudioLang || undefined,
      targetSubtitleLang: targetSubLang || undefined,
    });

    const resolved = resolveInitialTrackSelection(tracks, {
      ...(targetAudioId !== undefined || targetSubOverride !== undefined
        ? {
            targetOverride: {
              ...(targetAudioId !== undefined ? { audioId: targetAudioId } : {}),
              ...(targetSubOverride !== undefined ? { subtitleId: targetSubOverride } : {}),
            },
          }
        : {}),
      ...(persistedPref !== null ? { persistedItemPref: persistedPref } : {}),
      profileRules: {
        preferredAudioLanguages: effectiveAudioLangs,
        preferDefaultAudioTrack,
        preferredSubtitleLanguages: effectiveSubLangs,
        subtitleMode: effective.subtitleMode,
      },
    });

    if (appliedAudioItemRef.current !== activeTarget.itemKey && tracks.audio.length > 0) {
      appliedAudioItemRef.current = activeTarget.itemKey;
      if (resolved.audioId !== undefined && resolved.audioId !== tracks.selectedAudioId) {
        activeService.selectAudioTrack(resolved.audioId);
      }
    }

    if (
      appliedSubtitleItemRef.current !== activeTarget.itemKey &&
      (tracks.subtitles.length > 0 || tracks.selectedSubtitleId !== null)
    ) {
      appliedSubtitleItemRef.current = activeTarget.itemKey;
      if (
        resolved.subtitleId !== undefined &&
        (resolved.subtitleId === null || resolved.subtitleId !== tracks.selectedSubtitleId)
      ) {
        activeService.selectSubtitleTrack(resolved.subtitleId);
      }
    }
  }, [
    activeService,
    activeTarget.itemKey,
    effectiveAudioLangs,
    effectiveSubLangs,
    persistedPref,
    prefReady,
    preferDefaultAudioTrack,
    subtitleMode,
    targetAudioLang,
    targetSubLang,
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
