import type { CatalogService } from '@elv/data';
import { clampSyncDelayMs, type MediaTracks, type PlaybackService } from '@elv/playback';
import { type MutableRefObject, useCallback, useRef } from 'react';
import type { PlayTarget } from '../ports/play-target';
import type { OpenVideoEngine } from '../ports/video-host';
import { resolveTrackPreferenceScopeKey } from './track-preferences';

/**
 * Coordinates live audio/subtitle sync delay adjustments (`#59`, `#208` persistence) and adaptive
 * video quality rendition selection without inflating `PlayerScreen`.
 */
export function usePlayerSyncAndQuality(params: {
  readonly activeTarget: PlayTarget;
  readonly tracks: MediaTracks;
  readonly openedEngine: OpenVideoEngine | undefined;
  readonly audioDelayMs: number;
  readonly onChangeManualAudioDelayMs?: ((nextManualMs: number) => void) | undefined;
  readonly subtitleDelayMs: number;
  readonly selectedVideoQualityId: string | null;
  readonly serviceRef: MutableRefObject<PlaybackService | null>;
  readonly catalogRef: MutableRefObject<Partial<Pick<CatalogService, 'saveTrackPreference'>>>;
}) {
  const {
    activeTarget,
    tracks,
    openedEngine,
    audioDelayMs,
    onChangeManualAudioDelayMs,
    subtitleDelayMs,
    selectedVideoQualityId,
    serviceRef,
    catalogRef,
  } = params;

  const activeTargetRef = useRef(activeTarget);
  activeTargetRef.current = activeTarget;
  const audioDelayRef = useRef(audioDelayMs);
  audioDelayRef.current = audioDelayMs;
  const onChangeManualAudioDelayRef = useRef(onChangeManualAudioDelayMs);
  onChangeManualAudioDelayRef.current = onChangeManualAudioDelayMs;
  const subtitleDelayRef = useRef(subtitleDelayMs);
  subtitleDelayRef.current = subtitleDelayMs;

  const engine = openedEngine?.engine;
  const supportsAudioDelay =
    engine?.capabilities.audioDelay === true || engine?.setAudioDelay !== undefined;
  const supportsSubtitleDelay =
    engine?.capabilities.subtitleDelay === true || engine?.setSubtitleDelay !== undefined;
  const supportsVideoQuality = (tracks.videoQualities?.length ?? 0) > 0;

  const handleAdjustAudioDelay = useCallback(
    (deltaMs: number, reset = false): void => {
      const next = reset ? 0 : clampSyncDelayMs(audioDelayRef.current + deltaMs);
      audioDelayRef.current = next;
      if (onChangeManualAudioDelayRef.current !== undefined) {
        onChangeManualAudioDelayRef.current(next);
      } else {
        serviceRef.current?.setAudioDelay(next);
      }
      const save = catalogRef.current.saveTrackPreference;
      if (save === undefined) return;
      const cur = activeTargetRef.current;
      void Promise.resolve(
        save({
          scopeKey: resolveTrackPreferenceScopeKey(cur),
          sourceId: cur.sourceId,
          audioDelayMs: next,
        }),
      ).catch(() => undefined);
    },
    [catalogRef, serviceRef],
  );

  const handleAdjustSubtitleDelay = useCallback(
    (deltaMs: number, reset = false): void => {
      const next = reset ? 0 : clampSyncDelayMs(subtitleDelayRef.current + deltaMs);
      subtitleDelayRef.current = next;
      serviceRef.current?.setSubtitleDelay(next);
      const save = catalogRef.current.saveTrackPreference;
      if (save === undefined) return;
      const cur = activeTargetRef.current;
      void Promise.resolve(
        save({
          scopeKey: resolveTrackPreferenceScopeKey(cur),
          sourceId: cur.sourceId,
          subDelayMs: next,
        }),
      ).catch(() => undefined);
    },
    [catalogRef, serviceRef],
  );

  const handleSelectVideoQuality = useCallback(
    (id: string | null): void => {
      serviceRef.current?.selectVideoQuality(id);
    },
    [serviceRef],
  );

  const controlsProps = {
    ...(supportsAudioDelay ? { audioDelayMs, onAdjustAudioDelay: handleAdjustAudioDelay } : {}),
    ...(supportsSubtitleDelay
      ? { subtitleDelayMs, onAdjustSubtitleDelay: handleAdjustSubtitleDelay }
      : {}),
    ...(supportsVideoQuality
      ? { selectedVideoQualityId, onSelectVideoQuality: handleSelectVideoQuality }
      : {}),
  };

  return {
    controlsProps,
    sheetProps: controlsProps,
  };
}
