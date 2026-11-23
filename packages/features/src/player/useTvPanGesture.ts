import { useEffect, useRef } from 'react';
import type { OpenVideoEngine, TvPanGestureEvent } from '../ports/video-host';

/** Minimum vertical pan displacement (pt) required to trigger a TV player drawer (`#225`). */
const TV_PAN_VERTICAL_TRANSLATION_MIN = 48;

/** Minimum vertical pan velocity (pt/s) required to trigger a TV player drawer (`#225`). */
const TV_PAN_VERTICAL_VELOCITY_MIN = 280;

/** Lower bound on horizontal pan scrubbing sensitivity (`ms/pt`, `#225`). */
export const TV_PAN_SCRUB_MS_PER_PT_MIN = 120;

/** Upper bound on horizontal pan scrubbing sensitivity (`ms/pt`, `#225`). */
export const TV_PAN_SCRUB_MS_PER_PT_MAX = 450;

/** Fallback horizontal pan scrubbing sensitivity (`ms/pt`) when duration is unknown (`#225`). */
const TV_PAN_SCRUB_MS_PER_PT_DEFAULT = 180;

/** Computes a bounded VOD seek preview delta (ms) from a horizontal Siri Remote pan translation (`#225`). */
export function computeTvPanScrubDeltaMs(
  translation: number,
  durationMs: number | undefined,
): number {
  const hasDuration = durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0;
  const msPerPt = hasDuration
    ? Math.max(TV_PAN_SCRUB_MS_PER_PT_MIN, Math.min(TV_PAN_SCRUB_MS_PER_PT_MAX, durationMs / 4000))
    : TV_PAN_SCRUB_MS_PER_PT_DEFAULT;
  const delta = Math.round(translation * msPerPt);
  return hasDuration ? Math.max(-durationMs, Math.min(durationMs, delta)) : delta;
}

/** Options for {@link useTvPanGesture}. */
export interface UseTvPanGestureOptions {
  readonly openedEngine: OpenVideoEngine | undefined;
  readonly isTv: boolean;
  readonly hasService: boolean;
  readonly isVod: boolean;
  readonly hasChannelList: boolean;
  readonly anySheetOpen: boolean;
  readonly locked: boolean;
  readonly stillWatchingVisible: boolean;
  readonly durationMs: number | undefined;
  readonly onScrubPreview: (deltaMs: number) => void;
  readonly onScrubCommit: (deltaMs: number) => void;
  readonly onScrubCancel: () => void;
  readonly onOpenInfo: () => void;
  readonly onOpenChannelList: () => void;
}

/** Compact `PlayerScreen` adapter over {@link useTvPanGesture} (`#225`). */
export function usePlayerTvPan(params: {
  readonly openedEngine: OpenVideoEngine | undefined;
  readonly isTv: boolean;
  readonly hasService: boolean;
  readonly isVod: boolean;
  readonly hasChannelList: boolean;
  readonly anySheetOpen: boolean;
  readonly stillWatchingVisible: boolean;
  readonly durationMs: number | undefined;
  readonly controls: {
    readonly locked: boolean;
    readonly osdHidden: boolean;
    readonly infoOpen: boolean;
    readonly channelListOpen: boolean;
    readonly showProgressOsd: () => void;
    readonly toggleInfo: () => void;
    readonly toggleChannelList: () => void;
  };
  readonly recordActivity: () => void;
  readonly setScrubDeltaMs: (deltaMs: number | undefined) => void;
  readonly commitScrub: (deltaMs: number) => void;
}): void {
  const { controls } = params;
  useTvPanGesture({
    openedEngine: params.openedEngine,
    isTv: params.isTv,
    hasService: params.hasService,
    isVod: params.isVod,
    hasChannelList: params.hasChannelList,
    anySheetOpen: params.anySheetOpen,
    locked: controls.locked,
    stillWatchingVisible: params.stillWatchingVisible,
    durationMs: params.durationMs,
    onScrubPreview: (deltaMs) => {
      params.recordActivity();
      params.setScrubDeltaMs(deltaMs);
      if (controls.osdHidden) controls.showProgressOsd();
    },
    onScrubCommit: (deltaMs) => {
      params.setScrubDeltaMs(undefined);
      params.commitScrub(deltaMs);
    },
    onScrubCancel: () => params.setScrubDeltaMs(undefined),
    onOpenInfo: () => {
      params.recordActivity();
      if (!controls.infoOpen) controls.toggleInfo();
    },
    onOpenChannelList: () => {
      params.recordActivity();
      if (!controls.channelListOpen) controls.toggleChannelList();
    },
  });
}

/**
 * Integrates tvOS axis-locked Siri Remote touch-surface pan gestures with `PlayerScreen` (`#225`).
 * Enables native pan capture strictly during unobstructed TV playback so `UIFocusSystem` is never
 * hijacked while any sheet, drawer, lock, or prompt is visible.
 */
export function useTvPanGesture(options: UseTvPanGestureOptions): void {
  const {
    openedEngine,
    isTv,
    hasService,
    isVod,
    hasChannelList,
    anySheetOpen,
    locked,
    stillWatchingVisible,
    durationMs,
    onScrubPreview,
    onScrubCommit,
    onScrubCancel,
    onOpenInfo,
    onOpenChannelList,
  } = options;

  const enabled = isTv && hasService && !anySheetOpen && !locked && !stillWatchingVisible;

  const stateRef = useRef({
    enabled,
    isVod,
    hasChannelList,
    durationMs,
    onScrubPreview,
    onScrubCommit,
    onScrubCancel,
    onOpenInfo,
    onOpenChannelList,
  });
  stateRef.current = {
    enabled,
    isVod,
    hasChannelList,
    durationMs,
    onScrubPreview,
    onScrubCommit,
    onScrubCancel,
    onOpenInfo,
    onOpenChannelList,
  };

  const scrubbingRef = useRef(false);

  useEffect(() => {
    const setEnabled = openedEngine?.setTvPanGestureEnabled;
    if (!enabled && scrubbingRef.current) {
      scrubbingRef.current = false;
      stateRef.current.onScrubCancel();
    }
    setEnabled?.(enabled);
    return () => {
      if (enabled) setEnabled?.(false);
    };
  }, [enabled, openedEngine]);

  useEffect(() => {
    const subscribe = openedEngine?.onTvPanGesture;
    if (!isTv || !subscribe) return undefined;

    return subscribe((event: TvPanGestureEvent) => {
      const s = stateRef.current;
      if (!s.enabled) return;

      if (event.axis === 'horizontal') {
        if (!s.isVod) return;
        const deltaMs = computeTvPanScrubDeltaMs(event.translation, s.durationMs);
        if (event.phase === 'began' || event.phase === 'changed') {
          scrubbingRef.current = true;
          s.onScrubPreview(deltaMs);
        } else if (event.phase === 'ended') {
          scrubbingRef.current = false;
          s.onScrubCommit(deltaMs);
        } else if (event.phase === 'cancelled') {
          scrubbingRef.current = false;
          s.onScrubCancel();
        }
        return;
      }

      if (event.axis === 'vertical' && event.phase === 'ended') {
        const passed =
          Math.abs(event.translation) >= TV_PAN_VERTICAL_TRANSLATION_MIN ||
          Math.abs(event.velocity) >= TV_PAN_VERTICAL_VELOCITY_MIN;
        if (!passed) return;
        const downward = event.translation !== 0 ? event.translation > 0 : event.velocity > 0;
        if (downward) {
          s.onOpenInfo();
        } else if (s.hasChannelList) {
          s.onOpenChannelList();
        } else {
          s.onOpenInfo();
        }
      }
    });
  }, [isTv, openedEngine]);
}
