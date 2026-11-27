import {
  hexToRgba,
  IconButton,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import {
  type AccessibilityActionEvent,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { LiveSplitResizeMode } from './useLiveEmbeddedPreview';
import type { LiveWatchControl } from './useTvLiveNavigation';

/** Active in-tree overlay panel for the embedded split player. */
export type LiveSplitOverlayKind = 'tracks' | 'overflow' | null;

/** Props of {@link LiveSplitPlayerControls}. */
export interface LiveSplitPlayerControlsProps {
  readonly paused: boolean;
  readonly muted: boolean;
  readonly volume: number;
  readonly resizeMode: LiveSplitResizeMode;
  readonly docked: boolean;
  readonly isTv: boolean;
  readonly isPortrait: boolean;
  readonly disabled: boolean;
  readonly activeOverlay: LiveSplitOverlayKind;
  readonly focusedControl?: LiveWatchControl | null;
  readonly padX: number;
  readonly onTogglePlayPause: () => void;
  readonly onToggleMute: () => void;
  readonly onSetVolume: (volume: number) => void;
  readonly onCycleResizeMode: () => void;
  readonly onToggleTracks: () => void;
  readonly onToggleOverflow: () => void;
  readonly onWatchFullscreen: () => void;
  readonly onOpenMultiView?: () => void;
  readonly onOpenPopout?: () => void;
}

const VOLUME_STEP = 0.1;
const WEB_SYNTHETIC_PRESS_SUPPRESS_MS = 50;

function resizeModeLabel(mode: LiveSplitResizeMode, t: ReturnType<typeof useI18n>['t']): string {
  if (mode === 'cover') return t('player.aspect.fill');
  if (mode === 'stretch') return t('player.aspect.stretch');
  return t('player.aspect.fit');
}

interface KeyboardTargetLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  readonly getAttribute?: (name: string) => string | null;
  readonly closest?: (selector: string) => unknown;
}

function isInteractiveInputTarget(target: KeyboardTargetLike | undefined): boolean {
  if (!target) return false;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable === true) return true;
  return false;
}

function isInsideZapDrawerOrButton(target: KeyboardTargetLike | undefined): boolean {
  if (!target) return false;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'BUTTON' || tag === 'A') return true;
  if (target.getAttribute?.('role') === 'button') return true;
  if (typeof target.closest === 'function') {
    if (target.closest('[data-testid="live-zap-drawer"]') !== null) return true;
  }
  return false;
}

/**
 * Desktop web keyboard shortcuts for the Live Favorites embedded split player:
 * `Space`/`k` (play/pause), `m` (mute), `f` (fullscreen), `Shift+ArrowUp`/`+` and
 * `Shift+ArrowDown`/`-` (volume), `Escape` (close open overlay). Never hijacks text inputs or
 * plain `ArrowUp`/`ArrowDown` channel list navigation.
 */
export function useLiveSplitKeyboardShortcuts(opts: {
  readonly enabled: boolean;
  readonly volume: number;
  readonly activeOverlay: LiveSplitOverlayKind;
  readonly onTogglePlayPause: () => void;
  readonly onToggleMute: () => void;
  readonly onSetVolume: (volume: number) => void;
  readonly onWatchFullscreen: () => void;
  readonly onCloseOverlay: () => void;
}): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!opts.enabled || (Platform.OS as string) !== 'web') return;
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: {
          key?: string;
          shiftKey?: boolean;
          ctrlKey?: boolean;
          altKey?: boolean;
          metaKey?: boolean;
          target?: KeyboardTargetLike;
          preventDefault?: () => void;
        }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: {
          key?: string;
          shiftKey?: boolean;
          ctrlKey?: boolean;
          altKey?: boolean;
          metaKey?: boolean;
          target?: KeyboardTargetLike;
          preventDefault?: () => void;
        }) => void,
      ) => void;
    };

    const onKeyDown = (e: {
      key?: string;
      shiftKey?: boolean;
      ctrlKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
      target?: KeyboardTargetLike;
      preventDefault?: () => void;
    }) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (isInteractiveInputTarget(e.target)) return;
      const key = e.key;
      if (!key) return;
      const cur = optsRef.current;

      if (key === 'Escape' && cur.activeOverlay !== null) {
        e.preventDefault?.();
        cur.onCloseOverlay();
        return;
      }
      if (key === ' ') {
        if (isInsideZapDrawerOrButton(e.target)) return;
        e.preventDefault?.();
        cur.onTogglePlayPause();
        return;
      }
      if (key === 'k' || key === 'K') {
        e.preventDefault?.();
        cur.onTogglePlayPause();
        return;
      }
      if (key === 'm' || key === 'M') {
        e.preventDefault?.();
        cur.onToggleMute();
        return;
      }
      if (key === 'f' || key === 'F') {
        e.preventDefault?.();
        cur.onWatchFullscreen();
        return;
      }
      if (key === '+' || key === '=' || (key === 'ArrowUp' && e.shiftKey)) {
        e.preventDefault?.();
        cur.onSetVolume(Math.min(1, Math.round((cur.volume + VOLUME_STEP) * 100) / 100));
        return;
      }
      if (key === '-' || key === '_' || (key === 'ArrowDown' && e.shiftKey)) {
        e.preventDefault?.();
        cur.onSetVolume(Math.max(0, Math.round((cur.volume - VOLUME_STEP) * 100) / 100));
      }
    };

    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [opts.enabled]);
}

interface WebPointerWindowLike {
  addEventListener?: (
    type: string,
    fn: (e: { clientX?: number; buttons?: number }) => void,
  ) => void;
  removeEventListener?: (
    type: string,
    fn: (e: { clientX?: number; buttons?: number }) => void,
  ) => void;
}

/** Compact Cinema Quietude volume slider supporting pointer press/drag and accessibility adjustment. */
const SplitVolumeSlider = memo(function SplitVolumeSliderInner(p: {
  readonly volume: number;
  readonly muted: boolean;
  readonly disabled: boolean;
  readonly onSetVolume: (v: number) => void;
}): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const [trackWidth, setTrackWidth] = useState(84);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const suppressPressRef = useRef(false);
  const suppressPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackNodeRef = useRef<unknown>(null);

  const effectiveVol = p.muted ? 0 : p.volume;
  const pctNum = Math.round(effectiveVol * 100);
  const pctWidth = `${pctNum}%` as const;

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setTrackWidth(w);
  }, []);

  const commitRatio = useCallback(
    (x: number, width: number) => {
      if (p.disabled || width <= 0) return;
      const ratio = Math.max(0, Math.min(1, x / width));
      p.onSetVolume(Math.round(ratio * 100) / 100);
    },
    [p.disabled, p.onSetVolume],
  );
  const commitRatioRef = useRef(commitRatio);
  commitRatioRef.current = commitRatio;

  useEffect(
    () => () => {
      cleanupDragRef.current?.();
      cleanupDragRef.current = null;
      if (suppressPressTimerRef.current !== null) {
        clearTimeout(suppressPressTimerRef.current);
        suppressPressTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (p.disabled) {
      cleanupDragRef.current?.();
      cleanupDragRef.current = null;
    }
  }, [p.disabled]);

  const handlePress = useCallback(
    (e: GestureResponderEvent) => {
      if (suppressPressRef.current) {
        suppressPressRef.current = false;
        return;
      }
      const x = e.nativeEvent?.locationX;
      if (typeof x === 'number') commitRatio(x, trackWidth);
    },
    [commitRatio, trackWidth],
  );

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (p.disabled) return;
      if (event.nativeEvent.actionName === 'increment') {
        p.onSetVolume(Math.min(1, Math.round((effectiveVol + VOLUME_STEP) * 100) / 100));
      } else if (event.nativeEvent.actionName === 'decrement') {
        p.onSetVolume(Math.max(0, Math.round((effectiveVol - VOLUME_STEP) * 100) / 100));
      }
    },
    [effectiveVol, p.disabled, p.onSetVolume],
  );

  const isWeb = (Platform.OS as string) === 'web';
  const webPointerProps = isWeb
    ? ({
        onPointerDown: (e?: {
          button?: number;
          clientX?: number;
          currentTarget?: { getBoundingClientRect?: () => { left: number; width: number } };
        }) => {
          if (p.disabled) return;
          if (typeof e?.button === 'number' && e.button !== 0) return;
          cleanupDragRef.current?.();
          cleanupDragRef.current = null;
          suppressPressRef.current = true;
          if (suppressPressTimerRef.current !== null) {
            clearTimeout(suppressPressTimerRef.current);
            suppressPressTimerRef.current = null;
          }
          const rect = e?.currentTarget?.getBoundingClientRect?.();
          const measuredRect =
            rect && rect.width > 0 ? rect : trackWidth > 0 ? { left: 0, width: trackWidth } : null;
          if (measuredRect && typeof e?.clientX === 'number') {
            commitRatioRef.current(e.clientX - measuredRect.left, measuredRect.width);
          }
          const win =
            (globalThis as unknown as { window?: WebPointerWindowLike }).window ??
            (globalThis as unknown as WebPointerWindowLike);
          if (!win?.addEventListener || !measuredRect) return;
          const scheduleResetSuppress = () => {
            if (suppressPressTimerRef.current !== null) clearTimeout(suppressPressTimerRef.current);
            suppressPressTimerRef.current = setTimeout(() => {
              suppressPressRef.current = false;
              suppressPressTimerRef.current = null;
            }, WEB_SYNTHETIC_PRESS_SUPPRESS_MS);
          };
          const handleMove = (ev: { clientX?: number; buttons?: number }) => {
            if (ev.buttons === 0) {
              finishDrag();
              return;
            }
            if (typeof ev.clientX === 'number') {
              commitRatioRef.current(ev.clientX - measuredRect.left, measuredRect.width);
            }
          };
          const teardown = () => {
            win.removeEventListener?.('pointermove', handleMove);
            win.removeEventListener?.('pointerup', handleUp);
            win.removeEventListener?.('pointercancel', finishDrag);
            if (cleanupDragRef.current === teardown) cleanupDragRef.current = null;
          };
          const finishDrag = () => {
            teardown();
            scheduleResetSuppress();
          };
          const handleUp = (ev: { clientX?: number }) => {
            if (typeof ev.clientX === 'number') {
              commitRatioRef.current(ev.clientX - measuredRect.left, measuredRect.width);
            }
            finishDrag();
          };
          win.addEventListener('pointermove', handleMove);
          win.addEventListener('pointerup', handleUp);
          win.addEventListener('pointercancel', finishDrag);
          cleanupDragRef.current = teardown;
        },
      } as Record<string, unknown>)
    : undefined;

  return (
    <View style={styles.volumeWrap}>
      <Pressable
        ref={trackNodeRef as never}
        testID="live-split-volume"
        accessibilityRole="adjustable"
        accessibilityLabel={i18n.t('player.volume')}
        accessibilityValue={{ min: 0, max: 100, now: pctNum }}
        accessibilityActions={[
          { name: 'increment', label: i18n.t('player.volume') },
          { name: 'decrement', label: i18n.t('player.volume') },
        ]}
        onAccessibilityAction={handleAccessibilityAction}
        onLayout={handleLayout}
        onPress={handlePress}
        disabled={p.disabled}
        style={[styles.volumeTrackHitBox, webCursorPointer()]}
        {...webPointerProps}
      >
        <View
          pointerEvents="none"
          style={[
            styles.volumeTrack,
            { backgroundColor: theme.colors.subtleHighlight, borderRadius: theme.radius.pill },
          ]}
        >
          <View
            style={[
              styles.volumeFill,
              {
                width: pctWidth,
                backgroundColor: theme.colors.accent,
                borderRadius: theme.radius.pill,
              },
            ]}
          />
        </View>
      </Pressable>
      <Text
        testID="live-split-volume-label"
        numberOfLines={1}
        style={[
          theme.typography.caption,
          TABULAR_NUMS_STYLE,
          styles.volumeLabel,
          { color: theme.colors.textSecondary },
        ]}
      >
        {`${pctNum}%`}
      </Text>
    </View>
  );
});

/**
 * Full embedded Cinema Quietude player control strip for `LiveWatchStage`:
 * renders in flex-flow below the video surface when `docked` (HWND-safe desktop) or as a
 * translucent bar over the bottom scrim when `floating` (web/mobile/TV/modern composited desktop).
 */
export const LiveSplitPlayerControls = memo(function LiveSplitPlayerControlsInner(
  p: LiveSplitPlayerControlsProps,
): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const transition = webTransition(theme, 'opacity, background-color');

  const aspectText = resizeModeLabel(p.resizeMode, i18n.t);
  const aspectA11y = `${i18n.t('player.aspect')}: ${aspectText}`;
  const isMutedEffective = p.muted || p.volume === 0;

  return (
    <View
      testID="live-split-controls"
      style={[
        styles.bar,
        { paddingHorizontal: p.padX },
        p.docked
          ? {
              backgroundColor: theme.colors.bgSurface,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: theme.colors.surfaceBorder,
            }
          : [
              {
                backgroundColor: hexToRgba(theme.colors.bgCanvas, 0.78),
                borderColor: theme.colors.glassBorder,
                borderWidth: StyleSheet.hairlineWidth,
                borderRadius: theme.radius.modal,
              },
              webBackdropBlur(14),
            ],
        transition,
      ]}
    >
      <View style={styles.cluster}>
        <IconButton
          testID="live-split-play-pause"
          icon={p.paused ? 'play' : 'pause'}
          accessibilityLabel={i18n.t(p.paused ? 'player.play' : 'player.pause')}
          disabled={p.disabled}
          focusable={!p.isTv}
          focused={p.isTv && p.focusedControl === 'play-pause'}
          onPress={p.onTogglePlayPause}
        />
        <IconButton
          testID="live-split-mute"
          icon={isMutedEffective ? 'volumeMute' : 'audio'}
          accessibilityLabel={i18n.t(isMutedEffective ? 'player.unmute' : 'player.mute')}
          active={isMutedEffective}
          disabled={p.disabled}
          focusable={!p.isTv}
          onPress={p.onToggleMute}
        />
        {!p.isTv && !p.isPortrait ? (
          <SplitVolumeSlider
            volume={p.volume}
            muted={p.muted}
            disabled={p.disabled}
            onSetVolume={p.onSetVolume}
          />
        ) : null}
      </View>

      <View style={styles.cluster}>
        <IconButton
          testID="live-split-aspect"
          icon="aspect"
          accessibilityLabel={aspectA11y}
          disabled={p.disabled}
          focusable={!p.isTv}
          onPress={p.onCycleResizeMode}
        />
        <IconButton
          testID="live-split-tracks"
          icon="subtitles"
          accessibilityLabel={i18n.t('player.tracks')}
          active={p.activeOverlay === 'tracks'}
          disabled={p.disabled}
          focusable={!p.isTv}
          focused={p.isTv && p.focusedControl === 'tracks'}
          onPress={p.onToggleTracks}
        />
        {p.onOpenMultiView !== undefined ? (
          <IconButton
            testID="live-split-multiview"
            icon="multiview"
            accessibilityLabel={i18n.t('context.openMultiView')}
            disabled={p.disabled}
            focusable={!p.isTv}
            onPress={p.onOpenMultiView}
          />
        ) : null}
        {p.onOpenPopout !== undefined ? (
          <IconButton
            testID="live-split-popout"
            icon="popout"
            accessibilityLabel={i18n.t('context.openPopout')}
            disabled={p.disabled}
            focusable={!p.isTv}
            onPress={p.onOpenPopout}
          />
        ) : null}
        <IconButton
          testID="live-watch-fullscreen"
          icon="fullscreen"
          accessibilityLabel={i18n.t('live.stage.fullscreen')}
          disabled={p.disabled}
          focusable={!p.isTv}
          focused={p.isTv && p.focusedControl === 'fullscreen'}
          onPress={p.onWatchFullscreen}
        />
        <IconButton
          testID="live-split-overflow"
          icon="dots"
          accessibilityLabel={i18n.t('player.settings')}
          active={p.activeOverlay === 'overflow'}
          disabled={p.disabled}
          focusable={!p.isTv}
          focused={p.isTv && p.focusedControl === 'overflow'}
          onPress={p.onToggleOverflow}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 8,
  },
  cluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  volumeWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 6,
    height: 36,
  },
  volumeTrackHitBox: {
    width: 84,
    height: 36,
    justifyContent: 'center',
  },
  volumeTrack: {
    width: '100%',
    height: 4,
    overflow: 'hidden',
  },
  volumeFill: {
    height: 4,
  },
  volumeLabel: {
    minWidth: 32,
  },
});
