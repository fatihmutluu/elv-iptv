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
  /** When `true`, suspends all desktop player shortcuts (e.g. while a root PIN/profile overlay is open). */
  readonly isSuspended?: () => boolean;
  readonly canJumpPreviousChannel: () => boolean;
  readonly onJumpPreviousChannel: () => void;
  readonly canToggleTracks: () => boolean;
  readonly onToggleTracks: () => void;
  readonly canToggleInfo?: () => boolean;
  readonly onToggleInfo?: () => void;
  readonly canToggleStats?: () => boolean;
  readonly onToggleStats?: () => void;
  readonly canToggleChannelList?: () => boolean;
  readonly onToggleChannelList?: () => void;
  readonly canToggleMute: () => boolean;
  readonly onToggleMute: () => void;
  readonly canToggleFullscreen: () => boolean;
  readonly onToggleFullscreen: () => void;
  readonly canToggleAlwaysOnTop?: () => boolean;
  readonly onToggleAlwaysOnTop?: () => void;
  readonly isVod: () => boolean;
  readonly canUseShortcuts: () => boolean;
  readonly stepSeekMs?: () => number;
  readonly onSeekBy: (deltaMs: number) => void;
  readonly onSeekToRatio: (ratio: number) => void;
  readonly onSeekToEnd: () => void;
  readonly onPrevChapter?: () => void;
  readonly onNextChapter?: () => void;
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
  keyCode?: unknown;
  repeat?: unknown;
  isComposing?: unknown;
  shiftKey?: unknown;
  ctrlKey?: unknown;
  metaKey?: unknown;
  altKey?: unknown;
  target?: unknown;
  preventDefault?: () => void;
  stopPropagation?: () => void;
  stopImmediatePropagation?: () => void;
}

const IME_KEY_CODE = 229;

function isImeComposing(e: WebKeyEventLike): boolean {
  return e.isComposing === true || e.key === 'Process' || e.keyCode === IME_KEY_CODE;
}

function isSpaceKey(e: WebKeyEventLike): boolean {
  return e.key === ' ' || e.key === 'Spacebar';
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

  if (
    (e.key === 'i' || e.key === 'I') &&
    e.shiftKey === true &&
    e.repeat !== true &&
    guard.canToggleStats?.()
  ) {
    e.preventDefault?.();
    guard.onToggleStats?.();
    return true;
  }
  if (isPlainLetter(e, 'i', 'I') && guard.canToggleInfo?.()) {
    e.preventDefault?.();
    guard.onToggleInfo?.();
    return true;
  }
  if (isPlainLetter(e, 'g', 'G') && guard.canToggleChannelList?.()) {
    e.preventDefault?.();
    guard.onToggleChannelList?.();
    return true;
  }
  if (isPlainLetter(e, 'f', 'F') && guard.canToggleFullscreen()) {
    e.preventDefault?.();
    guard.onToggleFullscreen();
    return true;
  }
  if (isPlainLetter(e, 't', 'T') && guard.canToggleAlwaysOnTop?.()) {
    e.preventDefault?.();
    guard.onToggleAlwaysOnTop?.();
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

  if (isSpaceKey(e) && e.shiftKey !== true) {
    e.preventDefault?.();
    e.stopPropagation?.();
    e.stopImmediatePropagation?.();
    if (!repeat) guard.onTogglePlayPause();
    return true;
  }

  if (e.shiftKey === true && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault?.();
    const token = e.key === 'ArrowLeft' ? 'Shift+ArrowLeft' : 'Shift+ArrowRight';
    if (throttle.allow(token, repeat)) {
      guard.onSeekBy(e.key === 'ArrowLeft' ? -COARSE_SEEK_MS : COARSE_SEEK_MS);
    }
    return true;
  }

  const stepMs = guard.stepSeekMs?.() ?? STEP_SEEK_MS;
  if (e.key === 'j' || e.key === 'J') {
    e.preventDefault?.();
    if (throttle.allow('j', repeat)) guard.onSeekBy(-stepMs);
    return true;
  }
  if (e.key === 'k' || e.key === 'K') {
    e.preventDefault?.();
    if (!repeat) guard.onTogglePlayPause();
    return true;
  }
  if (e.key === 'l' || e.key === 'L') {
    e.preventDefault?.();
    if (throttle.allow('l', repeat)) guard.onSeekBy(stepMs);
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
  if ((e.key === '[' || e.key === 'PageUp') && guard.onPrevChapter !== undefined) {
    e.preventDefault?.();
    if (!repeat) guard.onPrevChapter();
    return true;
  }
  if ((e.key === ']' || e.key === 'PageDown') && guard.onNextChapter !== undefined) {
    e.preventDefault?.();
    if (!repeat) guard.onNextChapter();
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
          addEventListener?: (
            t: string,
            fn: (e: WebKeyEventLike) => void,
            capture?: boolean,
          ) => void;
          removeEventListener?: (
            t: string,
            fn: (e: WebKeyEventLike) => void,
            capture?: boolean,
          ) => void;
        };
      }
    ).window;
    if (win?.addEventListener === undefined || win.removeEventListener === undefined) return;
    let handledSpaceDown = false;
    const onKeyDown = (e: WebKeyEventLike): void => {
      if (guardRef.current.isSuspended?.()) return;
      if (isImeComposing(e)) return;
      if (isEditableWebTarget(e.target) || isEditableWebTarget(win.document?.activeElement)) return;
      if (dispatchVodShortcut(e, guardRef.current, throttle) && isSpaceKey(e)) {
        handledSpaceDown = true;
      }
    };
    const onKeyUp = (e: WebKeyEventLike): void => {
      throttle.reset();
      if (guardRef.current.isSuspended?.()) {
        handledSpaceDown = false;
        return;
      }
      if (handledSpaceDown && isSpaceKey(e)) {
        handledSpaceDown = false;
        e.preventDefault?.();
        e.stopPropagation?.();
        e.stopImmediatePropagation?.();
      }
    };
    const onBlur = (): void => {
      handledSpaceDown = false;
      throttle.reset();
    };
    win.addEventListener('keydown', onKeyDown, true);
    win.addEventListener('keyup', onKeyUp, true);
    win.addEventListener('blur', onBlur);
    return () => {
      handledSpaceDown = false;
      throttle.reset();
      win.removeEventListener?.('keydown', onKeyDown, true);
      win.removeEventListener?.('keyup', onKeyUp, true);
      win.removeEventListener?.('blur', onBlur);
    };
  }, [isWebDesktop, throttle]);

  if (formFactor !== 'desktop' || (Platform.OS as string) === 'web') return {};

  return {
    onKeyDown: (e: WebKeyEventLike) => {
      if (guardRef.current.isSuspended?.()) return;
      if (isImeComposing(e) || isEditableWebTarget(e.target) || hasControlModifier(e)) return;
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
