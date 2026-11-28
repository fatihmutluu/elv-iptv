import { isEditableWebTarget, useViewport } from '@elv/ui-kit';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

/** Minimal DOM keyboard event shape inspected by {@link matchDesktopShellShortcut}. */
export interface DesktopShellKeyEventLike {
  readonly key?: unknown;
  readonly keyCode?: unknown;
  readonly code?: unknown;
  readonly repeat?: unknown;
  readonly isComposing?: unknown;
  readonly ctrlKey?: unknown;
  readonly metaKey?: unknown;
  readonly altKey?: unknown;
  readonly shiftKey?: unknown;
  readonly target?: unknown;
  preventDefault?: () => void;
}

/** Action matched by a global desktop browsing shortcut. */
export type DesktopShellShortcutAction = 'shortcutSheet' | 'commandPalette' | 'search';

/** Guard state evaluated by {@link matchDesktopShellShortcut}. */
export interface DesktopShellShortcutGuardState {
  readonly isPlayerOpen?: boolean;
  readonly hasModalOverlay?: boolean;
}

/** Options accepted by {@link useDesktopShellShortcuts}. */
export interface UseDesktopShellShortcutsOptions {
  readonly isPlayerOpen: boolean;
  readonly hasModalOverlay: boolean;
  readonly onToggleShortcutSheet: () => void;
  readonly onToggleCommandPalette: () => void;
  readonly onOpenSearch: () => void;
}

const IME_KEY_CODE = 229;

/** Detects whether the active desktop platform is macOS so keycaps render `⌘` vs `Ctrl`. */
export function isMacPlatform(platform?: string): boolean {
  if (typeof platform === 'string') {
    return /mac|darwin/i.test(platform);
  }
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  const raw = nav?.platform || nav?.userAgent || '';
  return /mac/i.test(raw);
}

/** Returns `'⌘'` on macOS and `'Ctrl'` on Windows/Linux. */
export function formatShortcutModifier(mac = isMacPlatform()): string {
  return mac ? '⌘' : 'Ctrl';
}

function isImeComposing(e: DesktopShellKeyEventLike): boolean {
  return e.isComposing === true || e.key === 'Process' || e.keyCode === IME_KEY_CODE;
}

/**
 * Classifies a global desktop browsing `keydown` event (`?`/`F1`, `Ctrl/Cmd+K`, `/`/`Ctrl/Cmd+F`).
 * Returns `null` when player/modal overlays are open, during IME composition, on repeats, or when
 * focus is inside an editable input.
 */
export function matchDesktopShellShortcut(
  e: DesktopShellKeyEventLike,
  guard?: DesktopShellShortcutGuardState,
): DesktopShellShortcutAction | null {
  if (guard?.isPlayerOpen === true || guard?.hasModalOverlay === true) return null;
  if (e.repeat === true || isImeComposing(e)) return null;
  if (isEditableWebTarget(e.target)) return null;
  if (e.altKey === true) return null;

  const key = typeof e.key === 'string' ? e.key : '';
  const hasPrimary = e.ctrlKey === true || e.metaKey === true;

  if (hasPrimary && e.shiftKey !== true) {
    if (key === 'k' || key === 'K') return 'commandPalette';
    if (key === 'f' || key === 'F') return 'search';
    return null;
  }

  if (hasPrimary) return null;

  if (key === '?') return 'shortcutSheet';
  if (key === 'F1' && e.shiftKey !== true) return 'shortcutSheet';
  if (key === '/') return 'search';

  return null;
}

/**
 * Attaches global desktop browsing shortcuts (`?`/`F1` Shortcut Sheet, `Ctrl/Cmd+K` Command Palette,
 * `/` & `Ctrl/Cmd+F` Search) on desktop web, strictly disabled while the player, any modal overlay,
 * or an editable text target is active.
 */
export function useDesktopShellShortcuts(options: UseDesktopShellShortcutsOptions): void {
  const viewport = useViewport();
  const isWebDesktop = viewport.formFactor === 'desktop' && (Platform.OS as string) === 'web';
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!isWebDesktop) return;
    const win = (
      globalThis as {
        window?: {
          addEventListener?: (t: string, fn: (e: DesktopShellKeyEventLike) => void) => void;
          removeEventListener?: (t: string, fn: (e: DesktopShellKeyEventLike) => void) => void;
        };
      }
    ).window;
    if (!win?.addEventListener || !win.removeEventListener) return;

    const onKeyDown = (e: DesktopShellKeyEventLike): void => {
      const current = optionsRef.current;
      const action = matchDesktopShellShortcut(e, {
        isPlayerOpen: current.isPlayerOpen,
        hasModalOverlay: current.hasModalOverlay,
      });
      if (action === null) return;
      e.preventDefault?.();
      if (action === 'shortcutSheet') current.onToggleShortcutSheet();
      else if (action === 'commandPalette') current.onToggleCommandPalette();
      else current.onOpenSearch();
    };

    win.addEventListener('keydown', onKeyDown);
    return () => {
      win.removeEventListener?.('keydown', onKeyDown);
    };
  }, [isWebDesktop]);
}
