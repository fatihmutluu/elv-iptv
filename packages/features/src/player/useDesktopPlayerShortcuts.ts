import type { KeyEvent } from '@elv/focus-core';
import type { PlaybackClock } from '@elv/playback';
import { type FormFactor, isEditableWebTarget } from '@elv/ui-kit';
import { type MutableRefObject, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import {
  COARSE_SEEK_MS,
  createKeyRepeatThrottle,
  digitKeyToRatio,
  isScrubKey,
  type KeyRepeatThrottle,
  mapDesktopFallbackKey,
  type ScrubController,
  STEP_SEEK_MS,
} from './scrub-controller';

/** Minimal state read by desktop keyboard shortcut handlers. */
export interface DesktopShortcutGuard {
  readonly canJumpPreviousChannel: () => boolean;
  readonly onJumpPreviousChannel: () => void;
  readonly canToggleTracks: () => boolean;
  readonly onToggleTracks: () => void;
  readonly canToggleMute: () => boolean;
  readonly onToggleMute: () => void;
  readonly canToggleFullscreen: () => boolean;
  readonly onToggleFullscreen: () => void;
  readonly isVod: () => boolean;
  readonly canUseShortcuts: () => boolean;
  readonly onSeekBy: (deltaMs: number) => void;
  readonly onSeekToRatio: (ratio: number) => void;
  readonly onSeekToEnd: () => void;
  readonly onTogglePlayPause: () => void;
  readonly onKeyEvent: (event: KeyEvent) => void;
}

/** Whether a DOM button/radio/adjustable/switch currently owns web focus. */
export function isWebButtonActive(): boolean {
  if ((Platform.OS as string) !== 'web') return false;
  const active = (
    globalThis as { document?: { activeElement?: { getAttribute?: (n: string) => string | null } } }
  ).document?.activeElement;
  const role = active?.getAttribute?.('role');
  return role === 'button' || role === 'radio' || role === 'adjustable' || role === 'switch';
}

interface WebKeyEventLike {
  key?: unknown;
  repeat?: unknown;
  isComposing?: unknown;
  shiftKey?: unknown;
  ctrlKey?: unknown;
  metaKey?: unknown;
  altKey?: unknown;
  target?: unknown;
  preventDefault?: () => void;
}

function hasControlModifier(e: WebKeyEventLike): boolean {
  return e.ctrlKey === true || e.metaKey === true || e.altKey === true;
}

function isPreviousChannelShortcut(e: WebKeyEventLike): boolean {
  return (e.key === 'p' || e.key === 'P') && e.repeat !== true && !hasControlModifier(e);
}

function isPlainLetter(e: WebKeyEventLike, lower: string, upper: string): boolean {
  return (
    (e.key === lower || e.key === upper) &&
    e.repeat !== true &&
    e.shiftKey !== true &&
    !hasControlModifier(e)
  );
}

function dispatchVodShortcut(
  e: WebKeyEventLike,
  guard: DesktopShortcutGuard,
  throttle: KeyRepeatThrottle,
): boolean {
  if (typeof e.key !== 'string' || hasControlModifier(e)) return false;

  if (isPlainLetter(e, 'f', 'F') && guard.canToggleFullscreen()) {
    e.preventDefault?.();
    guard.onToggleFullscreen();
    return true;
  }
  if (isPlainLetter(e, 'c', 'C') && guard.canToggleTracks()) {
    e.preventDefault?.();
    guard.onToggleTracks();
    return true;
  }
  if (isPlainLetter(e, 'm', 'M') && guard.canToggleMute()) {
    e.preventDefault?.();
    guard.onToggleMute();
    return true;
  }
  if (isPreviousChannelShortcut(e) && guard.canJumpPreviousChannel()) {
    e.preventDefault?.();
    guard.onJumpPreviousChannel();
    return true;
  }

  if (!guard.isVod() || !guard.canUseShortcuts()) return false;
  const repeat = e.repeat === true;

  if (e.shiftKey === true && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault?.();
    const token = e.key === 'ArrowLeft' ? 'Shift+ArrowLeft' : 'Shift+ArrowRight';
    if (throttle.allow(token, repeat)) {
      guard.onSeekBy(e.key === 'ArrowLeft' ? -COARSE_SEEK_MS : COARSE_SEEK_MS);
    }
    return true;
  }

  if (e.key === 'j' || e.key === 'J') {
    e.preventDefault?.();
    if (throttle.allow('j', repeat)) guard.onSeekBy(-STEP_SEEK_MS);
    return true;
  }
  if (e.key === 'k' || e.key === 'K') {
    e.preventDefault?.();
    if (!repeat) guard.onTogglePlayPause();
    return true;
  }
  if (e.key === 'l' || e.key === 'L') {
    e.preventDefault?.();
    if (throttle.allow('l', repeat)) guard.onSeekBy(STEP_SEEK_MS);
    return true;
  }

  if (e.shiftKey === true) return false;

  if (e.key === 'Home') {
    e.preventDefault?.();
    if (!repeat) guard.onSeekToRatio(0);
    return true;
  }
  if (e.key === 'End') {
    e.preventDefault?.();
    if (!repeat) guard.onSeekToEnd();
    return true;
  }

  const mapped = mapDesktopFallbackKey(e.key);
  const ratio = mapped !== undefined ? digitKeyToRatio(mapped) : undefined;
  if (ratio !== undefined) {
    e.preventDefault?.();
    if (!repeat) guard.onSeekToRatio(ratio);
    return true;
  }

  return false;
}

/**
 * Attaches desktop keyboard shortcuts (`0–9`, `Home`, `End`, `Shift+Arrow`, `J/K/L`, `C`, `F`, `M`, `P`)
 * on web (`window`) with held-key repeat throttling and returns non-web desktop fallback handlers.
 */
export function useDesktopPlayerShortcuts(params: {
  formFactor: FormFactor;
  clockRef: MutableRefObject<PlaybackClock>;
  scrub: ScrubController;
  guard: DesktopShortcutGuard;
}): Record<string, unknown> {
  const { formFactor, clockRef, scrub, guard } = params;
  const isWebDesktop = formFactor === 'desktop' && (Platform.OS as string) === 'web';
  const guardRef = useRef<DesktopShortcutGuard>(guard);
  guardRef.current = guard;

  const throttleRef = useRef<KeyRepeatThrottle | null>(null);
  if (throttleRef.current === null) {
    throttleRef.current = createKeyRepeatThrottle({ now: () => clockRef.current.now() });
  }
  const throttle = throttleRef.current;

  useEffect(() => {
    if (!isWebDesktop) return;
    const win = (
      globalThis as {
        window?: {
          document?: { activeElement?: unknown };
          addEventListener?: (t: string, fn: (e: WebKeyEventLike) => void) => void;
          removeEventListener?: (t: string, fn: (e: WebKeyEventLike) => void) => void;
        };
      }
    ).window;
    if (win?.addEventListener === undefined || win.removeEventListener === undefined) return;
    const onKeyDown = (e: WebKeyEventLike): void => {
      if (e.isComposing === true) return;
      if (isEditableWebTarget(e.target) || isEditableWebTarget(win.document?.activeElement)) return;
      dispatchVodShortcut(e, guardRef.current, throttle);
    };
    const onKeyUp = (): void => {
      throttle.reset();
    };
    const onBlur = (): void => {
      throttle.reset();
    };
    win.addEventListener('keydown', onKeyDown);
    win.addEventListener('keyup', onKeyUp);
    win.addEventListener('blur', onBlur);
    return () => {
      throttle.reset();
      win.removeEventListener?.('keydown', onKeyDown);
      win.removeEventListener?.('keyup', onKeyUp);
      win.removeEventListener?.('blur', onBlur);
    };
  }, [isWebDesktop, throttle]);

  if (formFactor !== 'desktop' || (Platform.OS as string) === 'web') return {};

  return {
    onKeyDown: (e: WebKeyEventLike) => {
      if (e.isComposing === true || isEditableWebTarget(e.target) || hasControlModifier(e)) return;
      if (dispatchVodShortcut(e, guardRef.current, throttle)) return;
      const mapped = mapDesktopFallbackKey(e.key);
      if (!mapped) return;
      e.preventDefault?.();
      const repeat = e.repeat === true;
      if (!throttle.allow(mapped, repeat)) return;
      guardRef.current.onKeyEvent({
        key: mapped,
        kind: repeat ? 'repeat' : 'press',
        time: clockRef.current.now(),
      });
    },
    onKeyUp: (e: WebKeyEventLike) => {
      throttle.reset();
      const mapped = mapDesktopFallbackKey(e.key);
      if (mapped && isScrubKey(mapped)) scrub.commit();
    },
  };
}
