import {
  attachHorizontalDragScroll,
  type HorizontalDragElementLike,
} from '../horizontal-rail-drag';

interface RecordedListener {
  readonly fn: (event: unknown) => void;
  readonly capture: boolean;
}

function createFakeScrollElement(initial?: {
  scrollLeft?: number;
  scrollWidth?: number;
  clientWidth?: number;
}) {
  const listeners = new Map<string, RecordedListener[]>();
  const capturedPointers = new Set<number>();

  const el: HorizontalDragElementLike & {
    dispatch(type: string, event: Record<string, unknown>, capture?: boolean): void;
    listenerCount(): number;
  } = {
    scrollLeft: initial?.scrollLeft ?? 0,
    scrollWidth: initial?.scrollWidth ?? 1200,
    clientWidth: initial?.clientWidth ?? 400,
    style: { cursor: '', userSelect: '' },
    addEventListener(type, listener, options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      const list = listeners.get(type) ?? [];
      list.push({ fn: listener, capture });
      listeners.set(type, list);
    },
    removeEventListener(type, listener, options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      const list = listeners.get(type);
      if (!list) return;
      listeners.set(
        type,
        list.filter((entry) => !(entry.fn === listener && entry.capture === capture)),
      );
    },
    setPointerCapture(pointerId) {
      capturedPointers.add(pointerId);
    },
    releasePointerCapture(pointerId) {
      capturedPointers.delete(pointerId);
    },
    hasPointerCapture(pointerId) {
      return capturedPointers.has(pointerId);
    },
    dispatch(type, event, capture = false) {
      for (const entry of [...(listeners.get(type) ?? [])]) {
        if (entry.capture === capture) {
          entry.fn(event);
        }
      }
    },
    listenerCount() {
      let total = 0;
      for (const list of listeners.values()) total += list.length;
      return total;
    },
  };

  return el;
}

describe('attachHorizontalDragScroll', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('drags horizontally after crossing threshold, updates cursor/userSelect, and suppresses the trailing click', () => {
    const el = createFakeScrollElement({ scrollLeft: 100 });
    const detach = attachHorizontalDragScroll(el, { dragThresholdPx: 6 });

    el.dispatch('pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1, clientX: 200 });
    // Below threshold: should not start dragging yet
    el.dispatch('pointermove', { pointerId: 1, clientX: 196 });
    expect(el.scrollLeft).toBe(100);
    expect(el.style.cursor).toBe('');

    // Cross threshold (dx = -40 -> scrollLeft = 100 - (-40) = 140)
    el.dispatch('pointermove', { pointerId: 1, clientX: 160 });
    expect(el.scrollLeft).toBe(140);
    expect(el.style.cursor).toBe('grabbing');
    expect(el.style.userSelect).toBe('none');
    expect(el.hasPointerCapture?.(1)).toBe(true);

    // Release restores styles & pointer capture
    el.dispatch('pointerup', { pointerId: 1 });
    expect(el.style.cursor).toBe('');
    expect(el.style.userSelect).toBe('');
    expect(el.hasPointerCapture?.(1)).toBe(false);

    // Immediately-following synthetic click in capture phase is suppressed
    const preventDefault = jest.fn();
    const stopPropagation = jest.fn();
    el.dispatch('click', { preventDefault, stopPropagation }, true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);

    // Subsequent click is NOT suppressed
    const prevent2 = jest.fn();
    const stop2 = jest.fn();
    el.dispatch('click', { preventDefault: prevent2, stopPropagation: stop2 }, true);
    expect(prevent2).not.toHaveBeenCalled();
    expect(stop2).not.toHaveBeenCalled();

    detach();
    expect(el.listenerCount()).toBe(0);
  });

  it('clears click suppression on the next tick when no click fires after drag', () => {
    const el = createFakeScrollElement({ scrollLeft: 20 });
    const detach = attachHorizontalDragScroll(el);

    el.dispatch('pointerdown', { button: 0, pointerType: 'mouse', pointerId: 2, clientX: 100 });
    el.dispatch('pointermove', { pointerId: 2, clientX: 60 });
    el.dispatch('pointercancel', { pointerId: 2 });

    jest.runAllTimers();

    const preventDefault = jest.fn();
    const stopPropagation = jest.fn();
    el.dispatch('click', { preventDefault, stopPropagation }, true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();

    detach();
  });

  it('ignores non-mouse pointers, secondary mouse buttons, and interactive input targets', () => {
    const el = createFakeScrollElement({ scrollLeft: 50 });
    const detach = attachHorizontalDragScroll(el);

    // Touch pointer ignored
    el.dispatch('pointerdown', { button: 0, pointerType: 'touch', pointerId: 1, clientX: 100 });
    el.dispatch('pointermove', { pointerId: 1, clientX: 20 });
    expect(el.scrollLeft).toBe(50);

    // Right click ignored
    el.dispatch('pointerdown', { button: 2, pointerType: 'mouse', pointerId: 2, clientX: 100 });
    el.dispatch('pointermove', { pointerId: 2, clientX: 20 });
    expect(el.scrollLeft).toBe(50);

    // Interactive inputs ignored
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      el.dispatch('pointerdown', {
        button: 0,
        pointerType: 'mouse',
        pointerId: 3,
        clientX: 100,
        target: { tagName },
      });
      el.dispatch('pointermove', { pointerId: 3, clientX: 20 });
      expect(el.scrollLeft).toBe(50);
    }

    detach();
  });

  it('converts Shift+Wheel to horizontal scroll and optionally pans vertical wheel while releasing at bounds', () => {
    const el = createFakeScrollElement({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 400 });
    const detachShift = attachHorizontalDragScroll(el, { wheelPanVertical: false });

    // Plain vertical wheel ignored when wheelPanVertical is false
    const p1 = jest.fn();
    el.dispatch('wheel', { deltaX: 0, deltaY: 60, shiftKey: false, preventDefault: p1 });
    expect(el.scrollLeft).toBe(0);
    expect(p1).not.toHaveBeenCalled();

    // Shift + Wheel always pans horizontally
    const p2 = jest.fn();
    el.dispatch('wheel', { deltaX: 0, deltaY: 80, shiftKey: true, preventDefault: p2 });
    expect(el.scrollLeft).toBe(80);
    expect(p2).toHaveBeenCalledTimes(1);
    detachShift();

    // With wheelPanVertical: true
    el.scrollLeft = 0;
    const detachVert = attachHorizontalDragScroll(el, { wheelPanVertical: true });

    // At left edge scrolling left (deltaY < 0): releases smoothly without preventDefault
    const pLeftEdge = jest.fn();
    el.dispatch('wheel', { deltaX: 0, deltaY: -40, shiftKey: false, preventDefault: pLeftEdge });
    expect(el.scrollLeft).toBe(0);
    expect(pLeftEdge).not.toHaveBeenCalled();

    // Scrolling right (deltaY > 0): pans and prevents default
    const pRight = jest.fn();
    el.dispatch('wheel', { deltaX: 0, deltaY: 120, shiftKey: false, preventDefault: pRight });
    expect(el.scrollLeft).toBe(120);
    expect(pRight).toHaveBeenCalledTimes(1);

    // At right edge (scrollLeft >= scrollWidth - clientWidth - 1): releases smoothly
    el.scrollLeft = 600;
    const pRightEdge = jest.fn();
    el.dispatch('wheel', { deltaX: 0, deltaY: 50, shiftKey: false, preventDefault: pRightEdge });
    expect(el.scrollLeft).toBe(600);
    expect(pRightEdge).not.toHaveBeenCalled();

    detachVert();
  });

  it('restores cursor and userSelect if detached mid-drag', () => {
    const el = createFakeScrollElement({ scrollLeft: 10 });
    el.style.cursor = 'grab';
    el.style.userSelect = 'text';
    const detach = attachHorizontalDragScroll(el);

    el.dispatch('pointerdown', { button: 0, pointerType: 'mouse', pointerId: 5, clientX: 100 });
    el.dispatch('pointermove', { pointerId: 5, clientX: 50 });
    expect(el.style.cursor).toBe('grabbing');
    expect(el.style.userSelect).toBe('none');

    detach();
    expect(el.style.cursor).toBe('grab');
    expect(el.style.userSelect).toBe('text');
  });
});
