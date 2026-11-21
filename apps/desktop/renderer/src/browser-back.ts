/** Standard DOM `MouseEvent.button` value for Mouse Back (`XBUTTON1`). */
export const MOUSE_BACK_BUTTON = 3;
/** Standard DOM `MouseEvent.button` value for Mouse Forward (`XBUTTON2`). */
export const MOUSE_FORWARD_BUTTON = 4;

const DEFAULT_DEDUPE_MS = 80;

interface MouseButtonEventLike {
  readonly button?: unknown;
  preventDefault?: () => void;
}

interface KeyDownEventLike {
  readonly key?: unknown;
  preventDefault?: () => void;
  stopImmediatePropagation?: () => void;
}

/** Minimal `window` surface required by {@link attachMouseBackGuard}. */
export interface MouseBackWindowLike {
  addEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void;
  dispatchEvent?(event: Event): boolean;
}

function createEscapeEvent(type: 'keydown' | 'keyup'): Event {
  if (typeof KeyboardEvent === 'function') {
    return new KeyboardEvent(type, {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    });
  }
  return { type, key: 'Escape', bubbles: true, cancelable: true } as unknown as Event;
}

function dispatchEscape(win: MouseBackWindowLike): void {
  win.dispatchEvent?.(createEscapeEvent('keydown'));
  win.dispatchEvent?.(createEscapeEvent('keyup'));
}

/**
 * Intercepts desktop mouse Back (`button === 3`) and Forward (`button === 4`) events on `win`,
 * preventing Chromium history navigation and routing Back to `onBack` (or an `Escape` key press)
 * while deduping `mouseup`/`auxclick` and main-process `app-command` `Escape` in either order (#139).
 */
export function attachMouseBackGuard(
  win: MouseBackWindowLike,
  opts?: { onBack?: () => void; now?: () => number; dedupeMs?: number },
): () => void {
  const now = opts?.now ?? (() => performance.now());
  const dedupeMs = opts?.dedupeMs ?? DEFAULT_DEDUPE_MS;
  const triggerBack = opts?.onBack ?? (() => dispatchEscape(win));
  let lastMouseBackAt = Number.NEGATIVE_INFINITY;
  let lastExternalBackKeyAt = Number.NEGATIVE_INFINITY;
  let dispatchingOwnEscape = false;

  const fireBackIfFresh = (): void => {
    const t = now();
    if (t - lastMouseBackAt < dedupeMs || t - lastExternalBackKeyAt < dedupeMs) return;
    lastMouseBackAt = t;
    dispatchingOwnEscape = true;
    try {
      triggerBack();
    } finally {
      dispatchingOwnEscape = false;
    }
  };

  const onMouseDown = (raw: unknown): void => {
    const e = raw as MouseButtonEventLike | null;
    if (e?.button === MOUSE_BACK_BUTTON || e?.button === MOUSE_FORWARD_BUTTON) {
      e.preventDefault?.();
    }
  };

  const onMouseRelease = (raw: unknown): void => {
    const e = raw as MouseButtonEventLike | null;
    if (e?.button === MOUSE_BACK_BUTTON) {
      e.preventDefault?.();
      fireBackIfFresh();
    } else if (e?.button === MOUSE_FORWARD_BUTTON) {
      e.preventDefault?.();
    }
  };

  const onKeyDown = (raw: unknown): void => {
    if (dispatchingOwnEscape) return;
    const e = raw as KeyDownEventLike | null;
    if (e?.key !== 'Escape' && e?.key !== 'BrowserBack') return;
    const t = now();
    if (t - lastMouseBackAt < dedupeMs) {
      e.preventDefault?.();
      e.stopImmediatePropagation?.();
      return;
    }
    lastExternalBackKeyAt = t;
  };

  win.addEventListener('mousedown', onMouseDown);
  win.addEventListener('mouseup', onMouseRelease);
  win.addEventListener('auxclick', onMouseRelease);
  win.addEventListener('keydown', onKeyDown, true);

  return () => {
    win.removeEventListener('mousedown', onMouseDown);
    win.removeEventListener('mouseup', onMouseRelease);
    win.removeEventListener('auxclick', onMouseRelease);
    win.removeEventListener('keydown', onKeyDown, true);
  };
}
