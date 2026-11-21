import { describe, expect, it, vi } from 'vitest';
import {
  attachScrollBlurGuard,
  DEFAULT_SCROLL_SETTLE_MS,
  SCROLL_BLUR_STYLE_ID,
  SCROLLING_CLASS,
  type ScrollBlurStyleElementLike,
  type ScrollBlurWindowLike,
} from './scroll-blur-guard.ts';

function createFakeScrollWindow() {
  const classes = new Set<string>();
  const classAddCalls: string[] = [];
  const classRemoveCalls: string[] = [];
  const styles = new Map<string, ScrollBlurStyleElementLike>();
  const addedListeners: Array<{
    type: string;
    listener: () => void;
    options: boolean | { passive?: boolean; capture?: boolean } | undefined;
  }> = [];
  const removedListeners: Array<{
    type: string;
    listener: () => void;
    options: boolean | { passive?: boolean; capture?: boolean } | undefined;
  }> = [];
  const activeScrollListeners = new Set<() => void>();

  let nextRafId = 1;
  const pendingRafs = new Map<number, (time: number) => void>();
  let nextTimerId = 1;
  const pendingTimers = new Map<number, { cb: () => void; ms: number }>();

  const doc = {
    documentElement: {
      classList: {
        add(...tokens: string[]) {
          for (const t of tokens) {
            classAddCalls.push(t);
            classes.add(t);
          }
        },
        remove(...tokens: string[]) {
          for (const t of tokens) {
            classRemoveCalls.push(t);
            classes.delete(t);
          }
        },
        contains(token: string) {
          return classes.has(token);
        },
      },
    },
    head: {
      appendChild(node: ScrollBlurStyleElementLike) {
        styles.set(node.id, node);
        return node;
      },
    },
    getElementById(id: string) {
      return styles.get(id) ?? null;
    },
    createElement(_tagName: 'style'): ScrollBlurStyleElementLike {
      const el: ScrollBlurStyleElementLike = {
        id: '',
        textContent: null,
        remove() {
          styles.delete(el.id);
        },
      };
      return el;
    },
  };

  const win: ScrollBlurWindowLike = {
    document: doc,
    addEventListener(type, listener, options) {
      addedListeners.push({ type, listener, options });
      if (type === 'scroll') activeScrollListeners.add(listener);
    },
    removeEventListener(type, listener, options) {
      removedListeners.push({ type, listener, options });
      if (type === 'scroll') activeScrollListeners.delete(listener);
    },
    requestAnimationFrame(cb) {
      const id = nextRafId++;
      pendingRafs.set(id, cb);
      return id;
    },
    cancelAnimationFrame(handle) {
      pendingRafs.delete(handle);
    },
    setTimeout(cb, ms) {
      const id = nextTimerId++;
      pendingTimers.set(id, { cb, ms });
      return id;
    },
    clearTimeout(handle) {
      pendingTimers.delete(handle);
    },
  };

  return {
    win,
    classes,
    classAddCalls,
    classRemoveCalls,
    styles,
    addedListeners,
    removedListeners,
    activeScrollListeners,
    pendingRafs,
    pendingTimers,
    emitScroll() {
      for (const fn of [...activeScrollListeners]) fn();
    },
    flushNextRaf(time = 16) {
      const entries = [...pendingRafs.entries()];
      pendingRafs.clear();
      for (const [, cb] of entries) cb(time);
    },
    flushTimers() {
      const entries = [...pendingTimers.entries()];
      pendingTimers.clear();
      for (const [, entry] of entries) entry.cb();
    },
  };
}

describe('attachScrollBlurGuard', () => {
  it('injects an idempotent style scoped only to html.elv-scrolling and listens in passive capture mode', () => {
    const fake = createFakeScrollWindow();
    expect(DEFAULT_SCROLL_SETTLE_MS).toBe(120);
    expect(SCROLLING_CLASS).toBe('elv-scrolling');
    expect(SCROLL_BLUR_STYLE_ID).toBe('elv-scroll-blur-guard');

    const dispose = attachScrollBlurGuard(fake.win);

    const styleEl = fake.styles.get(SCROLL_BLUR_STYLE_ID);
    expect(styleEl).toBeDefined();
    expect(styleEl?.textContent).toContain(`html.${SCROLLING_CLASS}`);
    expect(styleEl?.textContent).toContain('backdrop-filter: none !important');
    expect(styleEl?.textContent).toContain('-webkit-backdrop-filter: none !important');
    expect(fake.classes.has(SCROLLING_CLASS)).toBe(false);

    expect(fake.addedListeners).toHaveLength(1);
    expect(fake.addedListeners[0]?.type).toBe('scroll');
    expect(fake.addedListeners[0]?.options).toEqual({ passive: true, capture: true });

    dispose();
    expect(fake.activeScrollListeners.size).toBe(0);
    expect(fake.styles.has(SCROLL_BLUR_STYLE_ID)).toBe(false);
  });

  it('throttles classList.add via rAF at most once per frame and clears after 120ms settle', () => {
    const fake = createFakeScrollWindow();
    const dispose = attachScrollBlurGuard(fake.win);

    // Rapid burst of 5 scroll events in a single frame schedules only 1 rAF and 1 active settle timer
    fake.emitScroll();
    fake.emitScroll();
    fake.emitScroll();
    fake.emitScroll();
    fake.emitScroll();

    expect(fake.pendingRafs.size).toBe(1);
    expect(fake.classAddCalls).toHaveLength(0);
    expect(fake.pendingTimers.size).toBe(1);
    expect([...fake.pendingTimers.values()][0]?.ms).toBe(120);

    // Frame tick applies elv-scrolling once
    fake.flushNextRaf();
    expect(fake.classes.has(SCROLLING_CLASS)).toBe(true);
    expect(fake.classAddCalls).toEqual([SCROLLING_CLASS]);

    // Subsequent scroll events while already scrolling do not touch classList or schedule new rAFs
    fake.emitScroll();
    fake.emitScroll();
    expect(fake.pendingRafs.size).toBe(0);
    expect(fake.classAddCalls).toEqual([SCROLLING_CLASS]);
    expect(fake.pendingTimers.size).toBe(1);

    // Settle timer fires after motion stops -> removes elv-scrolling cleanly
    fake.flushTimers();
    expect(fake.classes.has(SCROLLING_CLASS)).toBe(false);
    expect(fake.classRemoveCalls).toEqual([SCROLLING_CLASS]);

    dispose();
  });

  it('cancels pending rAF and settle timer on unmount and supports custom settleMs', () => {
    const fake = createFakeScrollWindow();
    const dispose = attachScrollBlurGuard(fake.win, { settleMs: 80 });

    fake.emitScroll();
    expect(fake.pendingRafs.size).toBe(1);
    expect(fake.pendingTimers.size).toBe(1);
    expect([...fake.pendingTimers.values()][0]?.ms).toBe(80);

    // Unmount before rAF or settle timer fires
    dispose();
    expect(fake.pendingRafs.size).toBe(0);
    expect(fake.pendingTimers.size).toBe(0);
    expect(fake.classes.has(SCROLLING_CLASS)).toBe(false);
    expect(fake.styles.has(SCROLL_BLUR_STYLE_ID)).toBe(false);

    // Idempotent second dispose does not throw
    expect(() => dispose()).not.toThrow();
  });

  it('keeps the injected style alive until the last mounted guard unmounts', () => {
    const fake = createFakeScrollWindow();
    const disposeA = attachScrollBlurGuard(fake.win);
    const disposeB = attachScrollBlurGuard(fake.win);

    expect(fake.styles.size).toBe(1);

    fake.emitScroll();
    fake.flushNextRaf();
    expect(fake.classes.has(SCROLLING_CLASS)).toBe(true);

    disposeA();
    expect(fake.styles.has(SCROLL_BLUR_STYLE_ID)).toBe(true);
    expect(fake.classes.has(SCROLLING_CLASS)).toBe(true);

    disposeB();
    expect(fake.styles.has(SCROLL_BLUR_STYLE_ID)).toBe(false);
    expect(fake.classes.has(SCROLLING_CLASS)).toBe(false);
  });

  it('is a safe no-op when document or documentElement is unavailable', () => {
    const addSpy = vi.fn();
    const dispose = attachScrollBlurGuard({
      document: null,
      addEventListener: addSpy,
      removeEventListener: vi.fn(),
    });
    expect(addSpy).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });
});
