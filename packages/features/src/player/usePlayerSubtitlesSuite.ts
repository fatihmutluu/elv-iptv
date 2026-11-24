import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyleConfig, subtitleStyleEquals } from '@elv/domain';
import type { MediaTracks, PlaybackService, PlaybackTimers } from '@elv/playback';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { OpenVideoEngine } from '../ports/video-host';
import { type SubtitleStyleField, stepSubtitleStyleField } from './subtitle-style-helpers';

const FEEDBACK_AUTO_HIDE_MS = 3_000;
const PENDING_EXTERNAL_TIMEOUT_MS = 8_000;

interface PendingExternalSubtitle {
  readonly id: string;
  readonly baselineExternalIds: ReadonlySet<string>;
}

/** Brief non-blocking feedback state after loading an external subtitle track (`#32`). */
export interface ExternalSubtitleFeedback {
  readonly kind: 'loaded' | 'failed';
  readonly key: number;
}

/**
 * Coordinates Wave F4 subtitle suite state for `PlayerScreen` (`#32`, `#402`):
 * - Persisted & live `SubtitleStyleConfig` synced to `PlaybackService.setSubtitleStyle` (zero restart)
 * - Dual secondary subtitle selection (`PlaybackService.selectSecondarySubtitleTrack`)
 * - Desktop file picker & in-tree URL external subtitle loading (`PlaybackService.addExternalSubtitle`)
 */
export function usePlayerSubtitlesSuite(params: {
  readonly activeItemKey: string;
  readonly tracks: MediaTracks;
  readonly openedEngine: OpenVideoEngine | undefined;
  readonly activeService: PlaybackService | null;
  readonly serviceRef: MutableRefObject<PlaybackService | null>;
  readonly timersRef: MutableRefObject<PlaybackTimers>;
  readonly subtitleStyleRef: MutableRefObject<SubtitleStyleConfig>;
  readonly subtitleStyleProp?: SubtitleStyleConfig | undefined;
  readonly onPersistSubtitleStyle?: ((next: SubtitleStyleConfig) => void) | undefined;
}) {
  const {
    activeItemKey,
    tracks,
    openedEngine,
    activeService,
    serviceRef,
    timersRef,
    subtitleStyleRef,
    subtitleStyleProp,
    onPersistSubtitleStyle,
  } = params;
  const externalStyle = subtitleStyleProp ?? DEFAULT_SUBTITLE_STYLE;

  const [subtitleStyle, setSubtitleStyle] = useState<SubtitleStyleConfig>(externalStyle);
  subtitleStyleRef.current = subtitleStyle;

  useEffect(() => {
    setSubtitleStyle((prev) => (subtitleStyleEquals(prev, externalStyle) ? prev : externalStyle));
  }, [externalStyle]);

  const appliedStyleRef = useRef<SubtitleStyleConfig | null>(null);
  useEffect(() => {
    if (activeService === null) {
      appliedStyleRef.current = null;
      return;
    }
    if (appliedStyleRef.current === null) {
      appliedStyleRef.current = subtitleStyle;
      if (!subtitleStyleEquals(subtitleStyle, DEFAULT_SUBTITLE_STYLE)) {
        activeService.setSubtitleStyle(subtitleStyle);
      }
      return;
    }
    if (subtitleStyleEquals(appliedStyleRef.current, subtitleStyle)) return;
    appliedStyleRef.current = subtitleStyle;
    activeService.setSubtitleStyle(subtitleStyle);
  }, [activeService, subtitleStyle]);

  const changeSubtitleStyle = useCallback(
    (next: SubtitleStyleConfig): void => {
      subtitleStyleRef.current = next;
      setSubtitleStyle(next);
      if (onPersistSubtitleStyle !== undefined) {
        onPersistSubtitleStyle(next);
      }
    },
    [onPersistSubtitleStyle, subtitleStyleRef],
  );

  const stepSubtitleStyle = useCallback(
    (field: SubtitleStyleField, delta: -1 | 1): void => {
      changeSubtitleStyle(stepSubtitleStyleField(subtitleStyleRef.current, field, delta));
    },
    [changeSubtitleStyle, subtitleStyleRef],
  );

  const resetSubtitleStyle = useCallback((): void => {
    changeSubtitleStyle(DEFAULT_SUBTITLE_STYLE);
  }, [changeSubtitleStyle]);

  const [urlOverlayOpen, setUrlOverlayOpen] = useState(false);
  const [feedback, setFeedback] = useState<ExternalSubtitleFeedback | null>(null);
  const mountedRef = useRef(true);
  const pickingRef = useRef(false);
  const extSeqRef = useRef(0);
  const feedbackSeqRef = useRef(0);
  const feedbackTimerRef = useRef<unknown>(undefined);
  const pendingExternalRef = useRef<PendingExternalSubtitle | null>(null);
  const pendingTimerRef = useRef<unknown>(undefined);
  const tracksRef = useRef<MediaTracks>(tracks);
  tracksRef.current = tracks;

  const clearFeedbackTimer = useCallback((): void => {
    if (feedbackTimerRef.current !== undefined) {
      timersRef.current.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = undefined;
    }
  }, [timersRef]);

  const clearPendingExternal = useCallback((): void => {
    pendingExternalRef.current = null;
    if (pendingTimerRef.current !== undefined) {
      timersRef.current.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = undefined;
    }
  }, [timersRef]);

  const showFeedback = useCallback(
    (kind: 'loaded' | 'failed'): void => {
      clearFeedbackTimer();
      const key = ++feedbackSeqRef.current;
      setFeedback({ kind, key });
      feedbackTimerRef.current = timersRef.current.setTimeout(() => {
        feedbackTimerRef.current = undefined;
        if (mountedRef.current) setFeedback(null);
      }, FEEDBACK_AUTO_HIDE_MS);
    },
    [clearFeedbackTimer, timersRef],
  );

  const startPendingExternal = useCallback(
    (id: string): void => {
      clearPendingExternal();
      clearFeedbackTimer();
      setFeedback(null);
      const baselineExternalIds = new Set(
        tracksRef.current.subtitles.filter((t) => t.external === true).map((t) => t.id),
      );
      pendingExternalRef.current = { id, baselineExternalIds };
      pendingTimerRef.current = timersRef.current.setTimeout(() => {
        pendingTimerRef.current = undefined;
        if (pendingExternalRef.current?.id === id) {
          pendingExternalRef.current = null;
          if (mountedRef.current) showFeedback('failed');
        }
      }, PENDING_EXTERNAL_TIMEOUT_MS);
    },
    [clearFeedbackTimer, clearPendingExternal, showFeedback, timersRef],
  );

  useEffect(() => {
    const pending = pendingExternalRef.current;
    if (pending === null) return;
    const prefixedId = `ext:${pending.id}`;
    const arrived = tracks.subtitles.some(
      (t) =>
        t.id === pending.id ||
        t.id === prefixedId ||
        (t.external === true && !pending.baselineExternalIds.has(t.id)),
    );
    if (arrived) {
      clearPendingExternal();
      showFeedback('loaded');
    }
  }, [tracks.subtitles, clearPendingExternal, showFeedback]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPendingExternal();
      clearFeedbackTimer();
    };
  }, [clearFeedbackTimer, clearPendingExternal]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: close URL overlay & transient feedback on item switch
  useEffect(() => {
    setUrlOverlayOpen(false);
    clearPendingExternal();
    clearFeedbackTimer();
    setFeedback(null);
  }, [activeItemKey, clearFeedbackTimer, clearPendingExternal]);

  const caps = openedEngine?.engine.capabilities;
  const supportsDualSubtitles = caps?.dualSubtitles === true;
  const canPickSubtitleFile = openedEngine?.pickSubtitleFile !== undefined;
  const canLoadSubtitleUrl = caps?.externalSubtitles === true || canPickSubtitleFile;
  const supportsExternalSubtitles = canPickSubtitleFile || canLoadSubtitleUrl;
  const supportsSubtitleStyling = openedEngine !== undefined && caps?.subtitleStyling !== false;

  const selectSecondarySubtitle = useCallback(
    (id: string | null): void => {
      serviceRef.current?.selectSecondarySubtitleTrack(id);
    },
    [serviceRef],
  );

  const pickSubtitleFileFn = openedEngine?.pickSubtitleFile;
  const handlePickSubtitleFile = useCallback((): void => {
    if (pickSubtitleFileFn === undefined || pickingRef.current) return;
    pickingRef.current = true;
    void Promise.resolve(pickSubtitleFileFn())
      .then((track) => {
        if (!mountedRef.current || track === null) return;
        const accepted = serviceRef.current?.addExternalSubtitle(track) === true;
        if (accepted) {
          startPendingExternal(track.id);
        } else {
          clearPendingExternal();
          showFeedback('failed');
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          clearPendingExternal();
          showFeedback('failed');
        }
      })
      .finally(() => {
        pickingRef.current = false;
      });
  }, [clearPendingExternal, pickSubtitleFileFn, serviceRef, showFeedback, startPendingExternal]);

  const openUrlOverlay = useCallback((): void => {
    setUrlOverlayOpen(true);
  }, []);

  const closeUrlOverlay = useCallback((): void => {
    setUrlOverlayOpen(false);
  }, []);

  const handleSubmitExternalUrl = useCallback(
    (input: { readonly uri: string; readonly label?: string }): boolean => {
      const id = `ext-url-${++extSeqRef.current}`;
      const accepted =
        serviceRef.current?.addExternalSubtitle({
          id,
          uri: input.uri,
          ...(input.label !== undefined ? { label: input.label } : {}),
        }) === true;
      if (accepted) {
        startPendingExternal(id);
        setUrlOverlayOpen(false);
      } else {
        clearPendingExternal();
        showFeedback('failed');
      }
      return accepted;
    },
    [clearPendingExternal, serviceRef, showFeedback, startPendingExternal],
  );

  const trackPickerProps = {
    dualSubtitles: supportsDualSubtitles,
    ...(supportsDualSubtitles ? { onSelectSecondarySubtitle: selectSecondarySubtitle } : {}),
    ...(canPickSubtitleFile ? { onPickSubtitleFile: handlePickSubtitleFile } : {}),
    ...(canLoadSubtitleUrl ? { onLoadSubtitleUrl: openUrlOverlay } : {}),
  };

  const settingsSheetProps = {
    ...trackPickerProps,
    ...(supportsSubtitleStyling
      ? { subtitleStyle, onChangeSubtitleStyle: changeSubtitleStyle }
      : {}),
  };

  const controlsProps = {
    hasDualSubtitles: supportsDualSubtitles,
    ...(supportsDualSubtitles ? { onSelectSecondarySubtitle: selectSecondarySubtitle } : {}),
    canPickSubtitleFile,
    ...(canPickSubtitleFile ? { onPickSubtitleFile: handlePickSubtitleFile } : {}),
    canLoadSubtitleUrl,
    ...(canLoadSubtitleUrl ? { onLoadSubtitleUrl: openUrlOverlay } : {}),
    hasSubtitleStyle: supportsSubtitleStyling,
    ...(supportsSubtitleStyling
      ? { onStepSubtitleStyle: stepSubtitleStyle, onResetSubtitleStyle: resetSubtitleStyle }
      : {}),
  };

  return {
    subtitleStyle,
    supportsExternalSubtitles,
    urlOverlayOpen,
    feedback,
    externalSubtitleOverlay: {
      visible: urlOverlayOpen,
      onSubmit: handleSubmitExternalUrl,
      onClose: closeUrlOverlay,
    },
    controlsProps,
    trackPickerProps,
    settingsSheetProps,
  };
}
