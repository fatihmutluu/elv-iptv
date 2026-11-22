import type { AppI18n } from '@elv/i18n';
import { useTheme, webCursorPointer, webTransition } from '@elv/ui-kit';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import {
  attachWebProgressDrag,
  createTouchScrubResponder,
  type PressGeometry,
  readEventRatio,
  readTrackRect,
} from './vod-progress-helpers';

const SLIDER_WIDTH = 68;
const VOLUME_KEY_STEP = 5;

/** Props of {@link OsdVolumeSlider}. */
export interface OsdVolumeSliderProps {
  readonly volume: number;
  readonly muted: boolean;
  readonly onChange: (volume: number) => void;
  readonly i18n: AppI18n;
  readonly disabled?: boolean;
  readonly testID?: string;
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

interface KeyEventLike {
  readonly key?: string;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

/**
 * Compact `68px` Cinema Quietude v2 inline volume slider (`#394`):
 * `3px` resting track expanding to `6px` on hover/drag with a circular thumb,
 * pointer click/drag clamping to `[0, 100]`, and `±5%` keyboard adjustment.
 */
export function OsdVolumeSlider({
  volume,
  muted,
  onChange,
  i18n,
  disabled = false,
  testID = 'osd-volume-slider',
}: OsdVolumeSliderProps): ReactElement {
  const theme = useTheme();
  const isWeb = (Platform.OS as string) === 'web';

  const [hovered, setHovered] = useState(false);
  const [dragVolume, setDragVolume] = useState<number | null>(null);

  const widthRef = useRef(SLIDER_WIDTH);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const dragRatioRef = useRef<number | null>(null);
  const justDraggedRef = useRef(false);
  const dragResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(
    () => () => {
      cleanupDragRef.current?.();
      if (dragResetTimerRef.current !== null) clearTimeout(dragResetTimerRef.current);
    },
    [],
  );

  const markDragEnded = (): void => {
    justDraggedRef.current = true;
    if (dragResetTimerRef.current !== null) clearTimeout(dragResetTimerRef.current);
    dragResetTimerRef.current = setTimeout(() => {
      justDraggedRef.current = false;
      dragResetTimerRef.current = null;
    }, 0);
  };

  const panResponderRef = useRef<ReturnType<typeof createTouchScrubResponder> | null>(null);
  panResponderRef.current ??= createTouchScrubResponder({
    canScrub: () => !disabledRef.current,
    getWidth: () => widthRef.current,
    onStart: (ratio) => {
      const next = clampVolume(ratio * 100);
      dragRatioRef.current = ratio;
      setDragVolume(next);
      onChangeRef.current(next);
    },
    onMove: (ratio) => {
      const next = clampVolume(ratio * 100);
      dragRatioRef.current = ratio;
      setDragVolume(next);
      onChangeRef.current(next);
    },
    onCommit: (ratio) => {
      const next = clampVolume(ratio * 100);
      dragRatioRef.current = null;
      setDragVolume(null);
      markDragEnded();
      onChangeRef.current(next);
    },
    onCancel: () => {
      dragRatioRef.current = null;
      setDragVolume(null);
    },
  });

  const clampedVolume = clampVolume(volume);
  const effectiveVolume = dragVolume !== null ? dragVolume : muted ? 0 : clampedVolume;
  const isMutedOrZero = (muted && dragVolume === null) || effectiveVolume === 0;
  const isActive = !disabled && (hovered || dragVolume !== null);
  const fillColor = isMutedOrZero ? theme.colors.textMuted : theme.colors.accent;

  const startWebDrag = (event: PressGeometry): void => {
    if (!isWeb || disabled) return;
    const btn = event.nativeEvent?.button ?? event.button;
    if (typeof btn === 'number' && btn !== 0) return;
    justDraggedRef.current = false;
    const rect = readTrackRect(event.currentTarget, widthRef.current);
    const initial = readEventRatio(event, widthRef.current, true);
    if (rect === null || initial === undefined) return;
    cleanupDragRef.current?.();
    const initialVol = clampVolume(initial * 100);
    dragRatioRef.current = initial;
    setDragVolume(initialVol);
    onChangeRef.current(initialVol);
    cleanupDragRef.current = attachWebProgressDrag({
      rect,
      initial,
      getLastRatio: () => dragRatioRef.current,
      onMove: (ratio) => {
        dragRatioRef.current = ratio;
        const next = clampVolume(ratio * 100);
        setDragVolume(next);
        onChangeRef.current(next);
      },
      onCommit: (ratio) => {
        cleanupDragRef.current = null;
        dragRatioRef.current = null;
        markDragEnded();
        setDragVolume(null);
        onChangeRef.current(clampVolume(ratio * 100));
      },
      onCancel: () => {
        cleanupDragRef.current = null;
        dragRatioRef.current = null;
        setDragVolume(null);
      },
    });
  };

  const handleKeyDown = (event: KeyEventLike): void => {
    if (disabled) return;
    const key = event.key;
    let next: number | undefined;
    if (key === 'ArrowRight' || key === 'ArrowUp') {
      next = clampVolume(effectiveVolume + VOLUME_KEY_STEP);
    } else if (key === 'ArrowLeft' || key === 'ArrowDown') {
      next = clampVolume(effectiveVolume - VOLUME_KEY_STEP);
    } else if (key === 'Home') {
      next = 0;
    } else if (key === 'End') {
      next = 100;
    }
    if (next === undefined) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    onChangeRef.current(next);
  };

  const interactiveProps = {
    onKeyDown: handleKeyDown,
    ...(isWeb
      ? {
          onHoverIn: () => {
            if (!disabled) setHovered(true);
          },
          onHoverOut: () => setHovered(false),
          onPointerEnter: () => {
            if (!disabled) setHovered(true);
          },
          onPointerLeave: () => setHovered(false),
          onPointerDown: startWebDrag,
        }
      : {}),
  } as Record<string, unknown>;

  return (
    <Pressable
      testID={testID}
      disabled={disabled}
      focusable={!disabled}
      accessibilityRole="adjustable"
      accessibilityLabel={i18n.t('player.volume')}
      accessibilityState={{ disabled }}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: effectiveVolume,
        text: `${effectiveVolume}%`,
      }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => {
        if (disabled) return;
        const action = event.nativeEvent.actionName;
        if (action === 'increment') {
          onChangeRef.current(clampVolume(effectiveVolume + VOLUME_KEY_STEP));
        } else if (action === 'decrement') {
          onChangeRef.current(clampVolume(effectiveVolume - VOLUME_KEY_STEP));
        }
      }}
      onLayout={(event) => {
        const w = event.nativeEvent.layout.width;
        if (w > 0) widthRef.current = w;
      }}
      onPress={(event) => {
        if (disabled) return;
        if (justDraggedRef.current) {
          justDraggedRef.current = false;
          return;
        }
        const ratio = readEventRatio(event as unknown as PressGeometry, widthRef.current, true);
        if (ratio === undefined || !Number.isFinite(ratio)) return;
        onChangeRef.current(clampVolume(ratio * 100));
      }}
      {...interactiveProps}
      style={[
        styles.hitBox,
        disabled ? styles.disabled : undefined,
        !disabled ? webCursorPointer() : undefined,
      ]}
    >
      <View
        testID={`${testID}-rail`}
        pointerEvents="none"
        style={[
          styles.rail,
          {
            height: isActive ? 6 : 3,
            backgroundColor: theme.colors.bgCard,
            borderColor: theme.colors.surfaceBorder,
          },
          webTransition(theme, 'height', theme.motion.fastMs),
        ]}
      >
        <View
          testID={`${testID}-fill`}
          style={[styles.fill, { width: `${effectiveVolume}%`, backgroundColor: fillColor }]}
        />
      </View>
      <View
        testID={`${testID}-thumb`}
        pointerEvents="none"
        style={[
          styles.thumb,
          {
            left: `${effectiveVolume}%`,
            backgroundColor: theme.colors.textPrimary,
            borderColor: theme.colors.bgCanvas,
            opacity: isActive ? 1 : 0,
          },
          webTransition(theme, 'opacity, transform', theme.motion.fastMs),
        ]}
      />
      {!isWeb && !disabled ? (
        <View
          testID={`${testID}-touch-area`}
          style={StyleSheet.absoluteFill}
          {...panResponderRef.current.panHandlers}
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hitBox: {
    position: 'relative',
    width: SLIDER_WIDTH,
    minHeight: 28,
    justifyContent: 'center',
    direction: 'ltr',
  },
  disabled: {
    opacity: 0.45,
  },
  rail: {
    height: 3,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    direction: 'ltr',
  },
  fill: {
    height: '100%',
  },
  thumb: {
    position: 'absolute',
    width: 12,
    height: 12,
    marginLeft: -6,
    borderRadius: 6,
    borderWidth: 1.5,
  },
});
