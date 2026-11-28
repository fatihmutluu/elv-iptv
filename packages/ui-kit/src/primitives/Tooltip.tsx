import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { TOOLTIP_MAX_WIDTH_PX, TooltipBubble, useTooltipHost } from '../theme/tooltip-host';
import { useViewport } from '../viewport';
import type { RectLike } from './safe-hover-geometry';

const DEFAULT_DELAY_MS = 320;
const TOOLTIP_OFFSET_PX = 8;
const VIEWPORT_EDGE_MARGIN_PX = 8;

/** Placement direction for {@link Tooltip}. */
export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

/** Props of {@link Tooltip}. */
export interface TooltipProps {
  /** Primary tooltip text. Empty or undefined renders `children` untouched. */
  readonly content: string | undefined;
  /** Optional secondary descriptive hint (e.g. keyboard shortcut). */
  readonly description?: string | undefined;
  /** Preferred bubble side relative to the anchor (default `'top'`). */
  readonly placement?: TooltipPlacement;
  /** Hover delay in milliseconds before revealing the bubble (default `320`). */
  readonly delayMs?: number;
  /** Disables the tooltip and renders `children` untouched when `true`. */
  readonly disabled?: boolean;
  readonly testID?: string;
  readonly children: ReactElement;
}

interface FixedCoords {
  readonly left: number;
  readonly top: number;
}

interface WebWindowMetrics {
  readonly innerWidth?: number;
  readonly innerHeight?: number;
}

function readAnchorRect(node: unknown): RectLike | null {
  if (!node || typeof node !== 'object') return null;
  const candidate = node as { getBoundingClientRect?: () => RectLike };
  if (typeof candidate.getBoundingClientRect !== 'function') return null;
  const rect = candidate.getBoundingClientRect();
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function computeFixedCoords(
  anchor: RectLike,
  placement: TooltipPlacement,
  contentLength: number,
  descriptionLength: number,
): FixedCoords {
  const win = (globalThis as { window?: WebWindowMetrics }).window;
  const vw = typeof win?.innerWidth === 'number' && win.innerWidth > 0 ? win.innerWidth : 1280;
  const vh = typeof win?.innerHeight === 'number' && win.innerHeight > 0 ? win.innerHeight : 720;

  const maxChars = Math.max(contentLength, descriptionLength);
  const estWidth = Math.min(TOOLTIP_MAX_WIDTH_PX, Math.max(72, maxChars * 7.5 + 24));
  const estHeight = descriptionLength > 0 ? 48 : 30;
  const anchorCenterX = anchor.left + anchor.width / 2;
  const anchorCenterY = anchor.top + anchor.height / 2;

  let effectivePlacement = placement;
  if (placement === 'top' && anchor.top - TOOLTIP_OFFSET_PX - estHeight < VIEWPORT_EDGE_MARGIN_PX) {
    effectivePlacement = 'bottom';
  } else if (
    placement === 'bottom' &&
    anchor.top + anchor.height + TOOLTIP_OFFSET_PX + estHeight > vh - VIEWPORT_EDGE_MARGIN_PX
  ) {
    effectivePlacement = 'top';
  } else if (
    placement === 'left' &&
    anchor.left - TOOLTIP_OFFSET_PX - estWidth < VIEWPORT_EDGE_MARGIN_PX
  ) {
    effectivePlacement = 'right';
  } else if (
    placement === 'right' &&
    anchor.left + anchor.width + TOOLTIP_OFFSET_PX + estWidth > vw - VIEWPORT_EDGE_MARGIN_PX
  ) {
    effectivePlacement = 'left';
  }

  let rawLeft = anchorCenterX - estWidth / 2;
  let rawTop = anchor.top - TOOLTIP_OFFSET_PX - estHeight;

  if (effectivePlacement === 'bottom') {
    rawTop = anchor.top + anchor.height + TOOLTIP_OFFSET_PX;
  } else if (effectivePlacement === 'left') {
    rawLeft = anchor.left - TOOLTIP_OFFSET_PX - estWidth;
    rawTop = anchorCenterY - estHeight / 2;
  } else if (effectivePlacement === 'right') {
    rawLeft = anchor.left + anchor.width + TOOLTIP_OFFSET_PX;
    rawTop = anchorCenterY - estHeight / 2;
  }

  return {
    left: Math.round(
      clamp(rawLeft, VIEWPORT_EDGE_MARGIN_PX, vw - estWidth - VIEWPORT_EDGE_MARGIN_PX),
    ),
    top: Math.round(
      clamp(rawTop, VIEWPORT_EDGE_MARGIN_PX, vh - estHeight - VIEWPORT_EDGE_MARGIN_PX),
    ),
  };
}

function getFallbackPlacementStyle(placement: TooltipPlacement): ViewStyle {
  switch (placement) {
    case 'bottom':
      return { top: '100%', marginTop: TOOLTIP_OFFSET_PX, alignSelf: 'center' };
    case 'left':
      return { right: '100%', marginRight: TOOLTIP_OFFSET_PX, top: 0 };
    case 'right':
      return { left: '100%', marginLeft: TOOLTIP_OFFSET_PX, top: 0 };
    default:
      return { bottom: '100%', marginBottom: TOOLTIP_OFFSET_PX, alignSelf: 'center' };
  }
}

/**
 * Cinema Quietude v2 pointer-only hover tooltip (`UI_UX_PHILOSOPHY.md` §1).
 * Renders `children` directly untouched on TV, touch, non-web platforms, or when disabled/empty.
 */
export function Tooltip({
  content,
  description,
  placement = 'top',
  delayMs = DEFAULT_DELAY_MS,
  disabled = false,
  testID,
  children,
}: TooltipProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const host = useTooltipHost();
  const tooltipId = useId();
  const trimmedContent = content?.trim() ?? '';
  const trimmedDescription = description?.trim() ?? '';
  const isTv = viewport.inputModality === 'tv' || viewport.formFactor === 'tv';
  const isTouch = viewport.inputModality === 'touch';
  const isPointerPlatform = Platform.OS === 'web' && !isTv && !isTouch;
  const hasContent = trimmedContent.length > 0;
  const canPreserveAnchor = isPointerPlatform && hasContent;
  const isActive = canPreserveAnchor && !disabled;

  const [inlineVisible, setInlineVisible] = useState(false);
  const [inlineCoords, setInlineCoords] = useState<FixedCoords | null>(null);
  const anchorRef = useRef<ComponentRef<typeof View>>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearPendingTimer();
    host?.hideTooltip(tooltipId);
    setInlineVisible(false);
  }, [clearPendingTimer, host, tooltipId]);

  const showNow = useCallback(() => {
    const rect = readAnchorRect(anchorRef.current);
    const nextCoords = rect
      ? computeFixedCoords(rect, placement, trimmedContent.length, trimmedDescription.length)
      : null;
    if (host !== null) {
      host.showTooltip({
        id: tooltipId,
        content: trimmedContent,
        description: trimmedDescription,
        coords: nextCoords,
        testID: testID ? `${testID}-bubble` : undefined,
      });
      return;
    }
    setInlineCoords(nextCoords);
    setInlineVisible(true);
  }, [host, placement, testID, tooltipId, trimmedContent, trimmedDescription]);

  const handlePointerEnter = useCallback(() => {
    clearPendingTimer();
    if (delayMs <= 0) {
      showNow();
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      showNow();
    }, delayMs);
  }, [clearPendingTimer, delayMs, showNow]);

  useEffect(() => {
    if (!isActive) {
      hide();
    }
  }, [hide, isActive]);

  useEffect(() => {
    return () => {
      clearPendingTimer();
      host?.hideTooltip(tooltipId);
    };
  }, [clearPendingTimer, host, tooltipId]);

  if (!canPreserveAnchor) {
    return children;
  }

  const inlinePositionStyle: ViewStyle = inlineCoords
    ? ({
        position: 'fixed',
        left: inlineCoords.left,
        top: inlineCoords.top,
      } as unknown as ViewStyle)
    : getFallbackPlacementStyle(placement);

  const pointerHandlers = {
    onPointerEnter: handlePointerEnter,
    onPointerLeave: hide,
    onPointerDown: hide,
  };

  return (
    <View
      ref={anchorRef}
      testID={isActive ? testID : undefined}
      style={styles.anchor}
      {...(isActive ? pointerHandlers : {})}
    >
      {children}
      {isActive && host === null && inlineVisible ? (
        <TooltipBubble
          theme={theme}
          content={trimmedContent}
          description={trimmedDescription}
          positionStyle={inlinePositionStyle}
          testID={testID ? `${testID}-bubble` : undefined}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: 'relative',
  },
});
