/** Default settle window in milliseconds after the last scroll event before restoring backdrop blur. */
export const DEFAULT_SCROLL_SETTLE_MS = 120;

/** Root `<html>` class applied during active scroll motion to suspend expensive backdrop filters. */
export const SCROLLING_CLASS = 'elv-scrolling';

/** DOM element id of the idempotent `<style>` element injected by {@link attachScrollBlurGuard}. */
export const SCROLL_BLUR_STYLE_ID = 'elv-scroll-blur-guard';

const SCROLL_BLUR_STYLE_CSS = [
  `html.${SCROLLING_CLASS},`,
  `html.${SCROLLING_CLASS} *,`,
  `html.${SCROLLING_CLASS} *::before,`,
  `html.${SCROLLING_CLASS} *::after {`,
  '  backdrop-filter: none !important;',
  '  -webkit-backdrop-filter: none !important;',
  '}',
].join('\n');

/** Minimal `<style>` element surface required by {@link attachScrollBlurGuard}. */
export interface ScrollBlurStyleElementLike {
  id: string;
  textContent: string | null;
  remove(): void;
}

interface ScrollBlurDocumentLike {
  readonly documentElement: {
    readonly classList: {
      add(...tokens: string[]): void;
      remove(...tokens: string[]): void;
      contains(token: string): boolean;
    };
  } | null;
  readonly head: {
    appendChild(node: ScrollBlurStyleElementLike): unknown;
  } | null;
  getElementById(id: string): ScrollBlurStyleElementLike | null;
  createElement(tagName: 'style'): ScrollBlurStyleElementLike;
}

/** Minimal `window` surface required by {@link attachScrollBlurGuard}. */
export interface ScrollBlurWindowLike {
  readonly document?: ScrollBlurDocumentLike | null;
  addEventListener(
    type: string,
    listener: () => void,
    options?: boolean | { passive?: boolean; capture?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: () => void,
    options?: boolean | { passive?: boolean; capture?: boolean },
  ): void;
  requestAnimationFrame?(cb: (time: number) => void): number;
  cancelAnimationFrame?(handle: number): void;
  setTimeout?(cb: () => void, ms: number): number;
  clearTimeout?(handle: number): void;
}

/** Options for {@link attachScrollBlurGuard}. */
export interface ScrollBlurGuardOptions {
  /** Milliseconds after the last scroll event before removing {@link SCROLLING_CLASS}. */
  readonly settleMs?: number;
}

interface DocumentGuardState {
  mountCount: number;
  scrollingCount: number;
}

const documentStates = new WeakMap<object, DocumentGuardState>();

/**
 * Suspends `backdrop-filter` / `-webkit-backdrop-filter` across the document ONLY while a user is
 * actively scrolling any viewport or nested virtual list, keeping 100k grids and EPG timelines at
 * 60/120 fps on integrated GPUs with zero runtime overhead when idle (#156).
 */
export function attachScrollBlurGuard(
  targetWindow: Window | ScrollBlurWindowLike,
  options?: ScrollBlurGuardOptions,
): () => void {
  const win = targetWindow as ScrollBlurWindowLike;
  const doc = win.document;
  const root = doc?.documentElement;
  if (!doc || !root) return () => undefined;

  const settleMs =
    options?.settleMs !== undefined && Number.isFinite(options.settleMs) && options.settleMs >= 0
      ? options.settleMs
      : DEFAULT_SCROLL_SETTLE_MS;

  let docState = documentStates.get(doc);
  if (!docState) {
    docState = { mountCount: 0, scrollingCount: 0 };
    documentStates.set(doc, docState);
  }
  docState.mountCount += 1;

  if (!doc.getElementById(SCROLL_BLUR_STYLE_ID) && doc.head) {
    const styleEl = doc.createElement('style');
    styleEl.id = SCROLL_BLUR_STYLE_ID;
    styleEl.textContent = SCROLL_BLUR_STYLE_CSS;
    doc.head.appendChild(styleEl);
  }

  let disposed = false;
  let isScrolling = false;
  let rafHandle: number | null = null;
  let settleTimer: number | null = null;

  const scheduleTimer = (cb: () => void, ms: number): number =>
    win.setTimeout ? win.setTimeout(cb, ms) : Number(globalThis.setTimeout(cb, ms));

  const cancelTimer = (handle: number): void => {
    if (win.clearTimeout) win.clearTimeout(handle);
    else globalThis.clearTimeout(handle);
  };

  const markScrollingStart = (): void => {
    if (isScrolling) return;
    isScrolling = true;
    docState.scrollingCount += 1;
    if (docState.scrollingCount === 1) {
      root.classList.add(SCROLLING_CLASS);
    }
  };

  const markScrollingEnd = (): void => {
    if (!isScrolling) return;
    isScrolling = false;
    docState.scrollingCount = Math.max(0, docState.scrollingCount - 1);
    if (docState.scrollingCount === 0) {
      root.classList.remove(SCROLLING_CLASS);
    }
  };

  const onSettle = (): void => {
    settleTimer = null;
    if (rafHandle !== null) {
      win.cancelAnimationFrame?.(rafHandle);
      rafHandle = null;
    }
    markScrollingEnd();
  };

  const onScroll = (): void => {
    if (disposed) return;
    if (settleTimer !== null) {
      cancelTimer(settleTimer);
    }
    settleTimer = scheduleTimer(onSettle, settleMs);

    if (isScrolling || rafHandle !== null) return;

    if (win.requestAnimationFrame) {
      rafHandle = win.requestAnimationFrame(() => {
        rafHandle = null;
        if (disposed || settleTimer === null) return;
        markScrollingStart();
      });
    } else {
      markScrollingStart();
    }
  };

  win.addEventListener('scroll', onScroll, { passive: true, capture: true });

  return () => {
    if (disposed) return;
    disposed = true;
    win.removeEventListener('scroll', onScroll, { capture: true });
    if (rafHandle !== null) {
      win.cancelAnimationFrame?.(rafHandle);
      rafHandle = null;
    }
    if (settleTimer !== null) {
      cancelTimer(settleTimer);
      settleTimer = null;
    }
    markScrollingEnd();

    docState.mountCount = Math.max(0, docState.mountCount - 1);
    if (docState.mountCount === 0) {
      root.classList.remove(SCROLLING_CLASS);
      doc.getElementById(SCROLL_BLUR_STYLE_ID)?.remove();
      documentStates.delete(doc);
    }
  };
}
