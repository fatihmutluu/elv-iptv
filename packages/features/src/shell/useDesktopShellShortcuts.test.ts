import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));

vi.mock('@elv/ui-kit', () => ({
  useViewport: () => ({ formFactor: 'desktop' }),
  isEditableWebTarget: (target: unknown): boolean => {
    if (!target || typeof target !== 'object') return false;
    const el = target as { tagName?: string; isContentEditable?: boolean };
    if (el.isContentEditable === true) return true;
    const tag = (el.tagName ?? '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  },
}));

import {
  formatShortcutModifier,
  isMacPlatform,
  matchDesktopShellShortcut,
} from './useDesktopShellShortcuts';

describe('useDesktopShellShortcuts helpers (Wave Q7)', () => {
  it('detects macOS platforms cleanly and formats OS-aware modifier keycaps', () => {
    expect(isMacPlatform('MacIntel')).toBe(true);
    expect(isMacPlatform('darwin')).toBe(true);
    expect(isMacPlatform('Win32')).toBe(false);
    expect(isMacPlatform('Linux x86_64')).toBe(false);
    expect(formatShortcutModifier(true)).toBe('⌘');
    expect(formatShortcutModifier(false)).toBe('Ctrl');
  });

  it('matches ?, F1, Ctrl/Cmd+K, /, and Ctrl/Cmd+F while guarding editable targets, repeats, IME, and modals', () => {
    expect(matchDesktopShellShortcut({ key: '?', shiftKey: true })).toBe('shortcutSheet');
    expect(matchDesktopShellShortcut({ key: 'F1' })).toBe('shortcutSheet');
    expect(matchDesktopShellShortcut({ key: 'k', ctrlKey: true })).toBe('commandPalette');
    expect(matchDesktopShellShortcut({ key: 'K', metaKey: true })).toBe('commandPalette');
    expect(matchDesktopShellShortcut({ key: '/' })).toBe('search');
    // Turkish Q layout produces '/' with Shift+7
    expect(matchDesktopShellShortcut({ key: '/', shiftKey: true })).toBe('search');
    expect(matchDesktopShellShortcut({ key: 'f', ctrlKey: true })).toBe('search');
    expect(matchDesktopShellShortcut({ key: 'F', metaKey: true })).toBe('search');

    // AltGr / Alt chords and held repeats are ignored
    expect(matchDesktopShellShortcut({ key: 'k', ctrlKey: true, altKey: true })).toBeNull();
    expect(matchDesktopShellShortcut({ key: '?', altKey: true })).toBeNull();
    expect(matchDesktopShellShortcut({ key: 'F1', shiftKey: true })).toBeNull();
    expect(matchDesktopShellShortcut({ key: 'k', ctrlKey: true, repeat: true })).toBeNull();
    expect(matchDesktopShellShortcut({ key: '?', isComposing: true })).toBeNull();

    // Editable targets are never hijacked
    expect(matchDesktopShellShortcut({ key: '?', target: { tagName: 'INPUT' } })).toBeNull();
    expect(matchDesktopShellShortcut({ key: '/', target: { tagName: 'TEXTAREA' } })).toBeNull();
    expect(
      matchDesktopShellShortcut({ key: 'k', ctrlKey: true, target: { tagName: 'INPUT' } }),
    ).toBeNull();
    expect(
      matchDesktopShellShortcut({
        key: 'f',
        ctrlKey: true,
        target: { tagName: 'DIV', isContentEditable: true },
      }),
    ).toBeNull();

    // Suspended while player or modal overlay is open
    expect(
      matchDesktopShellShortcut(
        { key: 'k', ctrlKey: true },
        { isPlayerOpen: true, hasModalOverlay: false },
      ),
    ).toBeNull();
    expect(
      matchDesktopShellShortcut({ key: '?' }, { isPlayerOpen: false, hasModalOverlay: true }),
    ).toBeNull();
    expect(
      matchDesktopShellShortcut({ key: '/' }, { isPlayerOpen: false, hasModalOverlay: true }),
    ).toBeNull();
  });

  it('prevents default cleanly when dispatching matched shell shortcuts', () => {
    const preventDefault = vi.fn();
    const action = matchDesktopShellShortcut({
      key: 'k',
      ctrlKey: true,
      preventDefault,
    });
    expect(action).toBe('commandPalette');
  });
});
