import type { Key, KeyInput } from '@elv/focus-core';
import type { TextEntryController } from './text-entry';

/** Minimal DOM `KeyboardEvent` shape used on `Platform.OS === 'web'` (no DOM lib required in `tsconfig.ui.json`). */
export interface WebKeyEventLike {
  key: string;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
  preventDefault?: () => void;
}

/** Minimal DOM `window` shape used on `Platform.OS === 'web'`. */
export interface WebKeyWindowLike {
  addEventListener(type: 'keydown' | 'keyup', listener: (event: WebKeyEventLike) => void): void;
  addEventListener(type: 'blur', listener: () => void): void;
  removeEventListener(type: 'keydown' | 'keyup', listener: (event: WebKeyEventLike) => void): void;
  removeEventListener(type: 'blur', listener: () => void): void;
  document?: { activeElement?: unknown };
}

interface EditableElementLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  contentEditable?: unknown;
  role?: unknown;
  getAttribute?: (name: string) => unknown;
  blur?: () => void;
}

const WEB_KEYS: Readonly<Record<string, Key>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'select',
  ' ': 'select',
  Spacebar: 'select',
  Escape: 'back',
  Backspace: 'back',
  BrowserBack: 'back',
  GoBack: 'back',
  PageUp: 'channelUp',
  ChannelUp: 'channelUp',
  PageDown: 'channelDown',
  ChannelDown: 'channelDown',
  ContextMenu: 'menu',
  MediaPlayPause: 'playPause',
  MediaPlay: 'play',
  MediaPause: 'pause',
  MediaRewind: 'rewind',
  Rewind: 'rewind',
  MediaFastForward: 'fastForward',
  FastForward: 'fastForward',
  '0': 'digit0',
  '1': 'digit1',
  '2': 'digit2',
  '3': 'digit3',
  '4': 'digit4',
  '5': 'digit5',
  '6': 'digit6',
  '7': 'digit7',
  '8': 'digit8',
  '9': 'digit9',
};

const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  ' ',
  'Spacebar',
  'PageUp',
  'PageDown',
]);

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox']);
const IME_KEY_CODE = 229;

function isImeComposingEvent(event: WebKeyEventLike): boolean {
  return event.isComposing === true || event.key === 'Process' || event.keyCode === IME_KEY_CODE;
}

function isEditableRoleValue(value: unknown): boolean {
  return typeof value === 'string' && EDITABLE_ROLES.has(value.trim().toLowerCase());
}

/**
 * Reports whether a DOM event target or focused element is an editable text control (`<input>`, `<textarea>`,
 * `<select>`, `contentEditable`, or an ARIA `textbox`/`searchbox`/`combobox`), so global keyboard shortcuts and remote
 * key mappers avoid hijacking text entry (#136, #139).
 */
export function isEditableWebTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as EditableElementLike;
  if (el.isContentEditable === true) return true;
  if (typeof el.contentEditable === 'string') {
    const mode = el.contentEditable.trim().toLowerCase();
    if (mode === 'true' || mode === 'plaintext-only') return true;
  }
  if (typeof el.tagName === 'string' && EDITABLE_TAGS.has(el.tagName.toUpperCase())) return true;
  if (isEditableRoleValue(el.role)) return true;
  if (typeof el.getAttribute === 'function' && isEditableRoleValue(el.getAttribute('role'))) {
    return true;
  }
  return false;
}

function findEditable(event: WebKeyEventLike, win: WebKeyWindowLike): EditableElementLike | null {
  for (const candidate of [event.target, win.document?.activeElement]) {
    if (isEditableWebTarget(candidate)) return candidate as EditableElementLike;
  }
  return null;
}

/**
 * Subscribes to DOM `keydown`/`keyup`/`blur` on `win`, dropping IME composition events, auto-repeats (`event.repeat`),
 * and modifier shortcuts, preserving native editing inside editable targets, and canceling held keys on blur or cleanup.
 */
export function subscribeWebKeys(
  win: WebKeyWindowLike,
  textEntry: Pick<TextEntryController, 'isActive'>,
  now: () => number,
  emit: (input: KeyInput) => void,
): () => void {
  const held = new Set<Key>();
  let blurredInputOnEscape = false;

  const cancelAll = (): void => {
    const t = now();
    for (const key of held) emit({ key, action: 'cancel', time: t });
    held.clear();
    blurredInputOnEscape = false;
  };

  const onKeyDown = (event: WebKeyEventLike): void => {
    if (!event || typeof event.key !== 'string') return;
    if (event.defaultPrevented === true) return;
    if (isImeComposingEvent(event)) return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
    const editable = findEditable(event, win);
    if (editable !== null && !textEntry.isActive()) {
      if (event.key === 'Escape' && !event.repeat) {
        event.preventDefault?.();
        blurredInputOnEscape = true;
        editable.blur?.();
      }
      return;
    }
    if (
      textEntry.isActive() &&
      event.key !== 'Escape' &&
      event.key !== 'BrowserBack' &&
      event.key !== 'GoBack'
    ) {
      return;
    }
    const key = WEB_KEYS[event.key];
    if (!key) return;
    if (SCROLL_KEYS.has(event.key) || key === 'back') event.preventDefault?.();
    if (event.repeat || held.has(key)) return;
    held.add(key);
    emit({ key, action: 'down', time: now() });
  };

  const onKeyUp = (event: WebKeyEventLike): void => {
    if (!event || typeof event.key !== 'string') return;
    if (event.key === 'Escape' && blurredInputOnEscape) {
      blurredInputOnEscape = false;
      return;
    }
    const key = WEB_KEYS[event.key];
    if (!key) return;
    if (!held.delete(key)) return;
    emit({ key, action: 'up', time: now() });
  };

  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('blur', cancelAll);
  return () => {
    cancelAll();
    win.removeEventListener('keydown', onKeyDown);
    win.removeEventListener('keyup', onKeyUp);
    win.removeEventListener('blur', cancelAll);
  };
}
