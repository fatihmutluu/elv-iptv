import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  computeSafeAimTriangle,
  isPointInRect,
  isPointInTriangle,
  type Point,
  type RectLike,
  type Triangle,
} from './safe-hover-geometry';

const DEFAULT_CLOSE_DELAY_MS = 140;
const DEFAULT_AIM_TIMEOUT_MS = 300;
const DEFAULT_MARGIN_PX = 12;

/** Options configuring {@link useSafeHoverBridge} and {@link createSafeHoverController}. */
export interface SafeHoverBridgeOptions {
  /** Grace delay (ms) before closing when pointer leaves or moves away (default `140`). */
  readonly closeDelayMs?: number;
  /** Maximum duration (ms) to keep open while pointer travels inside the aim triangle (default `300`). */
  readonly aimTimeoutMs?: number;
  /** Outward pixel margin expanding the target panel rect for the aim corridor (default `12`). */
  readonly marginPx?: number;
  /** Disables hover opening/closing when `true`. */
  readonly disabled?: boolean;
  /** Invoked whenever `open` transitions between `true` and `false`. */
  readonly onOpenChange?: (open: boolean) => void;
}

/** Internal options for {@link createSafeHoverController}. */
export interface SafeHoverControllerOptions extends SafeHoverBridgeOptions {
  /** Reads the floating panel's current viewport bounding rect (web `getBoundingClientRect`). */
  readonly getPanelRect?: () => RectLike | null;
}

/** Headless safe-hover aim-triangle state machine returned by {@link createSafeHoverController}. */
export interface SafeHoverController {
  readonly isOpen: () => boolean;
  readonly isLocked: () => boolean;
  readonly setOpen: (next: boolean) => void;
  readonly setLocked: (locked: boolean) => void;
  readonly setDisabled: (disabled: boolean) => void;
  readonly enterTrigger: () => void;
  readonly leaveTrigger: (exitPoint?: Point | null) => void;
  readonly enterPanel: () => void;
  readonly leavePanel: () => void;
  readonly handlePointerMove: (pt: Point) => void;
  readonly dispose: () => void;
}

/** Pointer event props attachable to `<View>` or `<Pressable>` triggers and panels. */
export interface SafeHoverEventProps {
  readonly onPointerEnter?: (event?: unknown) => void;
  readonly onPointerLeave?: (event?: unknown) => void;
}

/** Return value of {@link useSafeHoverBridge}. */
export interface SafeHoverBridgeResult {
  readonly open: boolean;
  readonly setOpen: (next: boolean) => void;
  readonly setLocked: (locked: boolean) => void;
  readonly triggerProps: SafeHoverEventProps;
  readonly panelProps: SafeHoverEventProps;
  readonly triggerRef: RefObject<unknown>;
  readonly panelRef: RefObject<unknown>;
}

interface WebWindowLike {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
}

function getWebWindow(): WebWindowLike | null {
  const g = globalThis as { window?: WebWindowLike };
  return g.window ?? null;
}

function readElementRect(node: unknown): RectLike | null {
  if (!node || typeof node !== 'object') return null;
  const candidate = node as { getBoundingClientRect?: () => RectLike };
  if (typeof candidate.getBoundingClientRect !== 'function') return null;
  const rect = candidate.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function extractPointerPoint(event: unknown): Point | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as {
    clientX?: unknown;
    clientY?: unknown;
    nativeEvent?: { clientX?: unknown; clientY?: unknown };
  };
  const x = typeof e.clientX === 'number' ? e.clientX : e.nativeEvent?.clientX;
  const y = typeof e.clientY === 'number' ? e.clientY : e.nativeEvent?.clientY;
  if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
    return { x, y };
  }
  return null;
}

/**
 * Creates a headless safe-hover aim-triangle controller that protects diagonal pointer travel
 * from a trigger toward its floating panel and respects an active interaction lock (e.g. slider drag).
 */
export function createSafeHoverController(
  options: SafeHoverControllerOptions = {},
): SafeHoverController {
  const closeDelayMs = Math.max(0, options.closeDelayMs ?? DEFAULT_CLOSE_DELAY_MS);
  const aimTimeoutMs = Math.max(closeDelayMs, options.aimTimeoutMs ?? DEFAULT_AIM_TIMEOUT_MS);
  const marginPx = Math.max(0, options.marginPx ?? DEFAULT_MARGIN_PX);

  let open = false;
  let locked = false;
  let disabled = Boolean(options.disabled);
  let pointerInTrigger = false;
  let pointerInPanel = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let aimTimer: ReturnType<typeof setTimeout> | null = null;
  let activeTriangle: Triangle | null = null;
  let activePanelRect: RectLike | null = null;
  let windowMoveListener: ((event: unknown) => void) | null = null;

  const detachWindowMove = (): void => {
    if (windowMoveListener) {
      getWebWindow()?.removeEventListener?.('pointermove', windowMoveListener);
      windowMoveListener = null;
    }
    activeTriangle = null;
    activePanelRect = null;
  };

  const clearTimers = (): void => {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (aimTimer !== null) {
      clearTimeout(aimTimer);
      aimTimer = null;
    }
    detachWindowMove();
  };

  const commitOpen = (next: boolean): void => {
    if (open === next) return;
    open = next;
    options.onOpenChange?.(next);
  };

  const closeNow = (): void => {
    clearTimers();
    if (locked || pointerInTrigger || pointerInPanel) return;
    commitOpen(false);
  };

  const scheduleCloseTimer = (): void => {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
    }
    closeTimer = setTimeout(closeNow, closeDelayMs);
  };

  const handlePointerMove = (pt: Point): void => {
    if (!open || locked || pointerInTrigger || pointerInPanel) return;
    const inRect = activePanelRect !== null && isPointInRect(pt, activePanelRect, marginPx);
    const inTriangle =
      activeTriangle !== null &&
      isPointInTriangle(pt, activeTriangle.a, activeTriangle.b, activeTriangle.c);
    if (inRect || inTriangle) {
      scheduleCloseTimer();
      return;
    }
    // Pointer moved away from the aim corridor; stop extending and let closeTimer finish.
    detachWindowMove();
    if (closeTimer === null) {
      scheduleCloseTimer();
    }
  };

  const attachWindowMove = (): void => {
    const win = getWebWindow();
    if (!win?.addEventListener) return;
    if (windowMoveListener) {
      win.removeEventListener?.('pointermove', windowMoveListener);
    }
    windowMoveListener = (event: unknown) => {
      const pt = extractPointerPoint(event);
      if (pt) handlePointerMove(pt);
    };
    win.addEventListener('pointermove', windowMoveListener);
  };

  return {
    isOpen: () => open,
    isLocked: () => locked,
    setOpen: (next: boolean) => {
      clearTimers();
      if (!next) {
        pointerInTrigger = false;
        pointerInPanel = false;
      }
      commitOpen(next);
    },
    setLocked: (nextLocked: boolean) => {
      locked = nextLocked;
      if (locked) {
        clearTimers();
        return;
      }
      if (open && !pointerInTrigger && !pointerInPanel) {
        scheduleCloseTimer();
      }
    },
    setDisabled: (nextDisabled: boolean) => {
      disabled = nextDisabled;
      if (disabled) {
        clearTimers();
        pointerInTrigger = false;
        pointerInPanel = false;
        commitOpen(false);
      }
    },
    enterTrigger: () => {
      if (disabled) return;
      pointerInTrigger = true;
      clearTimers();
      commitOpen(true);
    },
    leaveTrigger: (exitPoint?: Point | null) => {
      pointerInTrigger = false;
      if (!open || locked || pointerInPanel) return;
      clearTimers();
      const panelRect = options.getPanelRect?.() ?? null;
      const triangle =
        exitPoint && panelRect ? computeSafeAimTriangle(exitPoint, panelRect, marginPx) : null;
      if (triangle && panelRect) {
        activeTriangle = triangle;
        activePanelRect = panelRect;
        attachWindowMove();
        aimTimer = setTimeout(closeNow, aimTimeoutMs);
      }
      scheduleCloseTimer();
    },
    enterPanel: () => {
      if (disabled) return;
      pointerInPanel = true;
      clearTimers();
      commitOpen(true);
    },
    leavePanel: () => {
      pointerInPanel = false;
      if (!open || locked || pointerInTrigger) return;
      clearTimers();
      scheduleCloseTimer();
    },
    handlePointerMove,
    dispose: () => {
      clearTimers();
    },
  };
}

/**
 * React hook bridging hover state between a trigger element and its floating panel using an
 * Amazon-style safe-hover aim triangle (`computeSafeAimTriangle`) and optional drag lock.
 * Acts as a zero-overhead no-op on non-web platforms.
 */
export function useSafeHoverBridge(options: SafeHoverBridgeOptions = {}): SafeHoverBridgeResult {
  const { closeDelayMs, aimTimeoutMs, marginPx, disabled = false, onOpenChange } = options;
  const isWeb = Platform.OS === 'web';
  const effectiveDisabled = disabled || !isWeb;

  const [open, setOpenState] = useState(false);
  const triggerRef = useRef<unknown>(null);
  const panelRef = useRef<unknown>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const controllerRef = useRef<SafeHoverController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createSafeHoverController({
      closeDelayMs,
      aimTimeoutMs,
      marginPx,
      disabled: effectiveDisabled,
      getPanelRect: () => readElementRect(panelRef.current),
      onOpenChange: (next) => {
        setOpenState(next);
        onOpenChangeRef.current?.(next);
      },
    });
  }

  useEffect(() => {
    controllerRef.current?.setDisabled(effectiveDisabled);
  }, [effectiveDisabled]);

  useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
    };
  }, []);

  const setOpen = useCallback((next: boolean) => {
    controllerRef.current?.setOpen(next);
  }, []);

  const setLocked = useCallback((nextLocked: boolean) => {
    controllerRef.current?.setLocked(nextLocked);
  }, []);

  const triggerProps = useMemo<SafeHoverEventProps>(() => {
    if (effectiveDisabled) return {};
    return {
      onPointerEnter: () => {
        controllerRef.current?.enterTrigger();
      },
      onPointerLeave: (event?: unknown) => {
        controllerRef.current?.leaveTrigger(extractPointerPoint(event));
      },
    };
  }, [effectiveDisabled]);

  const panelProps = useMemo<SafeHoverEventProps>(() => {
    if (effectiveDisabled) return {};
    return {
      onPointerEnter: () => {
        controllerRef.current?.enterPanel();
      },
      onPointerLeave: () => {
        controllerRef.current?.leavePanel();
      },
    };
  }, [effectiveDisabled]);

  return {
    open,
    setOpen,
    setLocked,
    triggerProps,
    panelProps,
    triggerRef,
    panelRef,
  };
}
