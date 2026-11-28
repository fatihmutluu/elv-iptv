/** Standard DOM `MouseEvent.button` value for Mouse Back (`XBUTTON1`). */
export const MOUSE_BACK_BUTTON = 3;
/** Standard DOM `MouseEvent.button` value for Mouse Forward (`XBUTTON2`). */
export const MOUSE_FORWARD_BUTTON = 4;

/** Deduplication window (ms) preventing twin mouse/chord/app-command Back double navigation. */
export const DEFAULT_BACK_DEDUPE_MS = 500;

interface MouseButtonEventLike {
  readonly button?: unknown;
  preventDefault?: () => void;
}

interface KeyDownEventLike {
  readonly key?: unknown;
  readonly code?: unknown;
  readonly altKey?: unknown;
  readonly ctrlKey?: unknown;
  readonly metaKey?: unknown;
  readonly shiftKey?: unknown;
  readonly repeat?: unknown;
  readonly target?: unknown;
  preventDefault?: () => void;
  stopImmediatePropagation?: () => void;
}

/** Minimal `window` surface required by {@link attachMouseBackGuard}. */
export interface MouseBackWindowLike {
  addEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: unknown) => void, capture?: boolean): void;
  dispatchEvent?(event: Event): boolean;
}

/** Options accepted by {@link attachMouseBackGuard}. */
export interface AttachMouseBackGuardOptions {
  readonly onBack?: () => void;
  readonly now?: () => number;
  readonly dedupeMs?: number;
  readonly platform?: string;
}

function isMacPlatform(platform?: string): boolean {
  if (typeof platform === 'string') {
    return /mac|darwin/i.test(platform);
  }
  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  const raw = nav?.platform || nav?.userAgent || '';
  return /mac/i.test(raw);
}

function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    getAttribute?: (name: string) => string | null;
  };
  if (el.isContentEditable === true) return true;
  const ce = el.getAttribute?.('contenteditable');
  if (ce === '' || ce === 'true' || ce === 'plaintext-only') return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function isHistoryBackChord(e: KeyDownEventLike, mac: boolean): boolean {
  if (mac) {
    return (
      e.metaKey === true &&
      e.ctrlKey !== true &&
      e.altKey !== true &&
      e.shiftKey !== true &&
      (e.key === '[' || e.code === 'BracketLeft')
    );
  }
  return (
    e.altKey === true &&
    e.ctrlKey !== true &&
    e.metaKey !== true &&
    e.shiftKey !== true &&
    e.key === 'ArrowLeft'
  );
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
 * Intercepts desktop mouse Back (`button === 3`), Forward (`button === 4`), and keyboard history
 * back chords (`Alt+ArrowLeft` on Windows/Linux, `Cmd+[` on macOS) on `win`, preventing Chromium
 * history navigation and routing Back to `onBack` (or an `Escape` key press) while deduping
 * `mouseup`/`auxclick`, held-chord repeats, and main-process `app-command` `Escape` within 500 ms (#139).
 */
export function attachMouseBackGuard(
  win: MouseBackWindowLike,
  opts?: AttachMouseBackGuardOptions,
): () => void {
  const now = opts?.now ?? (() => performance.now());
  const dedupeMs = opts?.dedupeMs ?? DEFAULT_BACK_DEDUPE_MS;
  const mac = isMacPlatform(opts?.platform);
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
    if (!e) return;

    if (isHistoryBackChord(e, mac)) {
      if (isEditableTarget(e.target)) return;
      e.preventDefault?.();
      e.stopImmediatePropagation?.();
      if (e.repeat === true) return;
      fireBackIfFresh();
      return;
    }

    if (e.key !== 'Escape' && e.key !== 'BrowserBack') return;
    if (e.key === 'BrowserBack' && e.repeat === true) {
      e.preventDefault?.();
      e.stopImmediatePropagation?.();
      return;
    }
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
