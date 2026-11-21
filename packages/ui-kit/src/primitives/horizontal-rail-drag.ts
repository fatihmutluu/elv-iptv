/** Options for {@link attachHorizontalDragScroll}. */
export interface HorizontalDragOptions {
  readonly dragThresholdPx?: number;
  readonly wheelPanVertical?: boolean;
}

/** Minimal scrollable DOM element shape used on `Platform.OS === 'web'`. */
export interface HorizontalDragElementLike {
  scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly style: {
    cursor: string;
    userSelect: string;
  };
  addEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: boolean | { passive?: boolean; capture?: boolean },
  ): void;
  removeEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: boolean | { passive?: boolean; capture?: boolean },
  ): void;
  setPointerCapture?: (pointerId: number) => void;
  releasePointerCapture?: (pointerId: number) => void;
  hasPointerCapture?: (pointerId: number) => boolean;
}

interface PointerEventLike {
  readonly button?: number;
  readonly pointerType?: string;
  readonly pointerId?: number;
  readonly clientX?: number;
  readonly target?: { readonly tagName?: unknown } | null;
}

interface WheelEventLike {
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly shiftKey?: boolean;
  preventDefault?: () => void;
}

interface ClickEventLike {
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

const INTERACTIVE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isInteractiveTarget(target: PointerEventLike['target']): boolean {
  if (!target || typeof target.tagName !== 'string') return false;
  return INTERACTIVE_TAGS.has(target.tagName.toUpperCase());
}

/**
 * Attaches mouse drag-to-scroll and optional wheel horizontal panning to a web scrollable element.
 * Suppresses the synthetic trailing `click` after an actual drag so dragging never activates cards.
 */
export function attachHorizontalDragScroll(
  el: HorizontalDragElementLike,
  opts: HorizontalDragOptions = {},
): () => void {
  const dragThresholdPx = opts.dragThresholdPx ?? 5;
  const wheelPanVertical = opts.wheelPanVertical ?? false;

  let activePointerId: number | null = null;
  let startX = 0;
  let startScrollLeft = 0;
  let isDragging = false;
  let suppressNextClick = false;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;
  let savedCursor = '';
  let savedUserSelect = '';

  const clearSuppressTimer = () => {
    if (suppressTimer !== null) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
    }
  };

  const restoreStyles = () => {
    el.style.cursor = savedCursor;
    el.style.userSelect = savedUserSelect;
  };

  const onPointerDown = (raw: unknown) => {
    const event = raw as PointerEventLike;
    if (event.button !== 0 || event.pointerType !== 'mouse') return;
    if (isInteractiveTarget(event.target)) return;
    if (typeof event.clientX !== 'number') return;

    activePointerId = event.pointerId ?? 0;
    startX = event.clientX;
    startScrollLeft = el.scrollLeft;
    isDragging = false;
  };

  const onPointerMove = (raw: unknown) => {
    if (activePointerId === null) return;
    const event = raw as PointerEventLike;
    if (event.pointerId !== undefined && event.pointerId !== activePointerId) return;
    if (typeof event.clientX !== 'number') return;

    const dx = event.clientX - startX;
    if (!isDragging) {
      if (Math.abs(dx) < dragThresholdPx) return;
      isDragging = true;
      savedCursor = el.style.cursor;
      savedUserSelect = el.style.userSelect;
      el.style.cursor = 'grabbing';
      el.style.userSelect = 'none';
      try {
        el.setPointerCapture?.(activePointerId);
      } catch {
        // Synthetic pointer events in tests or detached nodes may reject capture.
      }
    }
    el.scrollLeft = startScrollLeft - dx;
  };

  const finishDrag = (raw: unknown) => {
    if (activePointerId === null) return;
    const event = raw as PointerEventLike;
    if (event.pointerId !== undefined && event.pointerId !== activePointerId) return;

    const wasDragging = isDragging;
    const pointerId = activePointerId;
    activePointerId = null;
    isDragging = false;

    if (!wasDragging) return;
    restoreStyles();
    try {
      if (el.hasPointerCapture?.(pointerId)) {
        el.releasePointerCapture?.(pointerId);
      }
    } catch {
      // Ignore release failures on already-released pointers.
    }
    suppressNextClick = true;
    clearSuppressTimer();
    suppressTimer = setTimeout(() => {
      suppressNextClick = false;
      suppressTimer = null;
    }, 0);
  };

  const onClickCapture = (raw: unknown) => {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    clearSuppressTimer();
    const event = raw as ClickEventLike;
    event.stopPropagation?.();
    event.preventDefault?.();
  };

  const onWheel = (raw: unknown) => {
    const event = raw as WheelEventLike;
    const deltaY = typeof event.deltaY === 'number' ? event.deltaY : 0;
    const deltaX = typeof event.deltaX === 'number' ? event.deltaX : 0;

    if (event.shiftKey && Math.abs(deltaY) > 0) {
      el.scrollLeft += deltaY;
      event.preventDefault?.();
      return;
    }

    if (
      wheelPanVertical &&
      Math.abs(deltaY) > Math.abs(deltaX) &&
      el.scrollWidth > el.clientWidth + 1
    ) {
      const canPan =
        deltaY < 0 ? el.scrollLeft > 0 : el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
      if (canPan) {
        el.scrollLeft += deltaY;
        event.preventDefault?.();
      }
    }
  };

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', finishDrag);
  el.addEventListener('pointercancel', finishDrag);
  el.addEventListener('click', onClickCapture, true);
  el.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    if (isDragging) {
      restoreStyles();
      isDragging = false;
    }
    activePointerId = null;
    suppressNextClick = false;
    clearSuppressTimer();
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', finishDrag);
    el.removeEventListener('pointercancel', finishDrag);
    el.removeEventListener('click', onClickCapture, true);
    el.removeEventListener('wheel', onWheel, { passive: false });
  };
}
