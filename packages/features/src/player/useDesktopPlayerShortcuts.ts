import type { KeyEvent } from '@elv/focus-core';
import type { PlaybackClock } from '@elv/playback';
import { type FormFactor, isEditableWebTarget } from '@elv/ui-kit';
import { type MutableRefObject, useEffect } from 'react';
import { Platform } from 'react-native';
import { isScrubKey, mapDesktopFallbackKey, type ScrubController } from './scrub-controller';

/** Minimal state read by desktop keyboard shortcut handlers. */
export interface DesktopShortcutGuard {
  readonly canJumpPreviousChannel: () => boolean;
  readonly onJumpPreviousChannel: () => void;
  readonly onKeyEvent: (event: KeyEvent) => void;
}

interface WebKeyEventLike {
  key?: unknown;
  repeat?: unknown;
  ctrlKey?: unknown;
  metaKey?: unknown;
  altKey?: unknown;
  target?: unknown;
  preventDefault?: () => void;
}

function isPreviousChannelShortcut(e: WebKeyEventLike): boolean {
  return (
    (e.key === 'p' || e.key === 'P') &&
    e.repeat !== true &&
    e.ctrlKey !== true &&
    e.metaKey !== true &&
    e.altKey !== true
  );
}

/**
 * Attaches desktop `'p'`/`'P'` previous-channel shortcut on web (`window`) and returns non-web
 * desktop fallback `onKeyDown`/`onKeyUp` props for `PlayerScreen`.
 */
export function useDesktopPlayerShortcuts(params: {
  formFactor: FormFactor;
  clockRef: MutableRefObject<PlaybackClock>;
  scrub: ScrubController;
  guardRef: MutableRefObject<DesktopShortcutGuard>;
}): Record<string, unknown> {
  const { formFactor, clockRef, scrub, guardRef } = params;
  const isWebDesktop = formFactor === 'desktop' && (Platform.OS as string) === 'web';

  useEffect(() => {
    if (!isWebDesktop) return;
    const win = (
      globalThis as {
        window?: {
          addEventListener?: (t: string, fn: (e: WebKeyEventLike) => void) => void;
          removeEventListener?: (t: string, fn: (e: WebKeyEventLike) => void) => void;
        };
      }
    ).window;
    if (win?.addEventListener === undefined || win.removeEventListener === undefined) return;
    const onKeyDown = (e: WebKeyEventLike): void => {
      if (!isPreviousChannelShortcut(e) || isEditableWebTarget(e.target)) return;
      if (!guardRef.current.canJumpPreviousChannel()) return;
      e.preventDefault?.();
      guardRef.current.onJumpPreviousChannel();
    };
    win.addEventListener('keydown', onKeyDown);
    return () => {
      win.removeEventListener?.('keydown', onKeyDown);
    };
  }, [guardRef, isWebDesktop]);

  if (formFactor !== 'desktop' || (Platform.OS as string) === 'web') return {};

  return {
    onKeyDown: (e: WebKeyEventLike) => {
      if (isPreviousChannelShortcut(e) && guardRef.current.canJumpPreviousChannel()) {
        e.preventDefault?.();
        guardRef.current.onJumpPreviousChannel();
        return;
      }
      const mapped = mapDesktopFallbackKey(e.key);
      if (!mapped) return;
      e.preventDefault?.();
      guardRef.current.onKeyEvent({
        key: mapped,
        kind: e.repeat === true ? 'repeat' : 'press',
        time: clockRef.current.now(),
      });
    },
    onKeyUp: (e: WebKeyEventLike) => {
      const mapped = mapDesktopFallbackKey(e.key);
      if (mapped && isScrubKey(mapped)) scrub.commit();
    },
  };
}
