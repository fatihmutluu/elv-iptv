import type { AppI18n } from '@elv/i18n';
import {
  type FormFactor,
  Icon,
  Tooltip,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import {
  clampMiniPlayerWidth,
  computeCornerPosition,
  computeEdgeResizedMiniBounds,
  computeMiniPlayerBounds,
  MINI_PLAYER_DRAG_THRESHOLD_PX,
  MINI_PLAYER_SNAP_DURATION_MS,
  type MiniPlayerCorner,
  type MiniPlayerPosition,
  type MiniPlayerRect,
  type MiniPlayerResizeEdge,
  miniPlayerHeightForWidth,
  resizeCursorForEdge,
  snapToNearestCorner,
} from './mini-player-geometry';

/** Computed `16:9` bottom-right frame dimensions for the floating corner mini-player (`#233`). */
export interface MiniPlayerFrame {
  readonly width: number;
  readonly height: number;
  readonly right: number;
  readonly bottom: number;
}

const MIN_MINI_WIDTH = 220;
const MAX_MINI_WIDTH_DEFAULT = 320;
const MAX_MINI_WIDTH_TV = 360;
const PORTRAIT_BOTTOM_TAB_CLEARANCE = 68;
const RESIZE_EDGE_THICKNESS = 8;
const RESIZE_CORNER_SIZE = 14;

/**
 * Computes a `16:9` floating corner frame honoring `safeArea`, `overscan`, and portrait phone
 * bottom tab-bar clearance (`#233`).
 */
export function computeMiniPlayerFrame(input: {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly formFactor: FormFactor;
  readonly orientation: 'portrait' | 'landscape';
  readonly safeArea: { readonly right: number; readonly bottom: number };
  readonly overscan: { readonly x: number; readonly y: number };
}): MiniPlayerFrame {
  const safeW =
    Number.isFinite(input.viewportWidth) && input.viewportWidth > 0 ? input.viewportWidth : 1280;
  const maxWidth = input.formFactor === 'tv' ? MAX_MINI_WIDTH_TV : MAX_MINI_WIDTH_DEFAULT;
  const targetWidth = Math.round(safeW * (input.formFactor === 'phone' ? 0.56 : 0.28));
  const width = Math.max(MIN_MINI_WIDTH, Math.min(maxWidth, targetWidth));
  const height = Math.round((width * 9) / 16);
  const right = 16 + Math.max(0, input.safeArea.right) + Math.max(0, input.overscan.x);
  const portraitTabOffset =
    input.formFactor === 'phone' && input.orientation === 'portrait'
      ? PORTRAIT_BOTTOM_TAB_CLEARANCE
      : 0;
  const bottom =
    16 + portraitTabOffset + Math.max(0, input.safeArea.bottom) + Math.max(0, input.overscan.y);
  return { width, height, right, bottom };
}

interface PointerCoords {
  readonly clientX: number;
  readonly clientY: number;
}

interface WebWindowEvents {
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener: (type: string, listener: (event: unknown) => void) => void;
}

function readWebWindow(): WebWindowEvents | null {
  const win = (globalThis as { window?: Partial<WebWindowEvents> }).window;
  if (
    win &&
    typeof win.addEventListener === 'function' &&
    typeof win.removeEventListener === 'function'
  ) {
    return win as WebWindowEvents;
  }
  return null;
}

function supportsPointerEvents(): boolean {
  const win = (globalThis as unknown as { window?: object }).window;
  return win !== undefined && 'PointerEvent' in win;
}

const SUPPRESS_EXPAND_WINDOW_MS = 250;

function extractPointerCoords(event: unknown): PointerCoords | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as {
    clientX?: number;
    clientY?: number;
    pageX?: number;
    pageY?: number;
    nativeEvent?: { clientX?: number; clientY?: number; pageX?: number; pageY?: number };
  };
  const src = e.nativeEvent ?? e;
  const x = typeof src.clientX === 'number' ? src.clientX : src.pageX;
  const y = typeof src.clientY === 'number' ? src.clientY : src.pageY;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return null;
  }
  return { clientX: x, clientY: y };
}

function subscribeWebPointerSession(
  win: WebWindowEvents,
  onMove: (event: unknown) => void,
  onEnd: () => void,
  activeCleanupRef: { current: (() => void) | null },
): () => void {
  const usePointer = supportsPointerEvents();
  const cleanup = () => {
    if (usePointer) {
      win.removeEventListener('pointermove', onMove);
      win.removeEventListener('pointerup', onEnd);
      win.removeEventListener('pointercancel', onEnd);
    } else {
      win.removeEventListener('mousemove', onMove);
      win.removeEventListener('mouseup', onEnd);
    }
    if (activeCleanupRef.current === cleanup) {
      activeCleanupRef.current = null;
    }
  };
  activeCleanupRef.current = cleanup;
  if (usePointer) {
    win.addEventListener('pointermove', onMove);
    win.addEventListener('pointerup', onEnd);
    win.addEventListener('pointercancel', onEnd);
  } else {
    win.addEventListener('mousemove', onMove);
    win.addEventListener('mouseup', onEnd);
  }
  return cleanup;
}

/**
 * Interactive drag-to-move, velocity-projected corner-snapping, and OS edge/corner 16:9
 * resize controller for the floating in-app mini-player.
 */
export function useMiniPlayerController(params: {
  readonly enabled: boolean;
  readonly isTv: boolean;
  readonly reduceMotion: boolean;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly formFactor: FormFactor;
  readonly orientation: 'portrait' | 'landscape';
  readonly safeArea: {
    readonly top?: number;
    readonly right: number;
    readonly bottom: number;
    readonly left?: number;
  };
  readonly overscan: { readonly x: number; readonly y: number };
}) {
  const {
    enabled,
    isTv,
    reduceMotion,
    viewportWidth,
    viewportHeight,
    formFactor,
    orientation,
    safeArea,
    overscan,
  } = params;
  const isPortraitPhone = formFactor === 'phone' && orientation === 'portrait';
  const baseFrame = computeMiniPlayerFrame({
    viewportWidth,
    viewportHeight,
    formFactor,
    orientation,
    safeArea,
    overscan,
  });
  const bounds = computeMiniPlayerBounds(
    viewportWidth,
    viewportHeight,
    safeArea,
    overscan,
    isPortraitPhone,
  );

  const [corner, setCorner] = useState<MiniPlayerCorner>('bottom-right');
  const [customWidth, setCustomWidth] = useState<number | null>(null);
  const [freePos, setFreePos] = useState<MiniPlayerPosition | null>(null);

  const width =
    customWidth !== null
      ? clampMiniPlayerWidth(customWidth, viewportWidth, viewportHeight, isTv)
      : baseFrame.width;
  const height = miniPlayerHeightForWidth(width);
  const dockedPos = computeCornerPosition(corner, width, height, bounds);
  const effectivePos: MiniPlayerPosition =
    freePos !== null
      ? {
          left: Math.max(
            bounds.left,
            Math.min(Math.max(bounds.left, bounds.right - width), freePos.left),
          ),
          top: Math.max(
            bounds.top,
            Math.min(Math.max(bounds.top, bounds.bottom - height), freePos.top),
          ),
        }
      : dockedPos;

  const animPosRef = useRef<Animated.ValueXY | null>(null);
  if (animPosRef.current === null) {
    animPosRef.current = new Animated.ValueXY({ x: effectivePos.left, y: effectivePos.top });
  }
  const animPos = animPosRef.current;

  const isDraggingRef = useRef(false);
  const isResizingRef = useRef(false);
  const snappingRef = useRef(false);
  const snapTargetRef = useRef<{ readonly left: number; readonly top: number } | null>(null);
  const suppressExpandUntilRef = useRef(0);
  const snapAnimRef = useRef<Animated.CompositeAnimation | null>(null);
  const cleanupListenersRef = useRef<(() => void) | null>(null);

  const stateRef = useRef({
    corner,
    width,
    height,
    effectivePos,
    bounds,
    viewportWidth,
    viewportHeight,
    safeArea,
    overscan,
    isPortraitPhone,
    isTv,
    reduceMotion,
  });
  stateRef.current = {
    corner,
    width,
    height,
    effectivePos,
    bounds,
    viewportWidth,
    viewportHeight,
    safeArea,
    overscan,
    isPortraitPhone,
    isTv,
    reduceMotion,
  };

  useEffect(() => {
    if (!enabled) {
      cleanupListenersRef.current?.();
      cleanupListenersRef.current = null;
      snapAnimRef.current?.stop();
      snapAnimRef.current = null;
      snappingRef.current = false;
      snapTargetRef.current = null;
      isDraggingRef.current = false;
      isResizingRef.current = false;
      suppressExpandUntilRef.current = 0;
      return;
    }
    if (isDraggingRef.current || isResizingRef.current) return;
    if (
      snappingRef.current &&
      snapTargetRef.current !== null &&
      snapTargetRef.current.left === effectivePos.left &&
      snapTargetRef.current.top === effectivePos.top
    ) {
      return;
    }
    snapAnimRef.current?.stop();
    snapAnimRef.current = null;
    snappingRef.current = false;
    snapTargetRef.current = null;
    animPos.setValue({ x: effectivePos.left, y: effectivePos.top });
  }, [animPos, effectivePos.left, effectivePos.top, enabled]);

  useEffect(() => {
    return () => {
      cleanupListenersRef.current?.();
      cleanupListenersRef.current = null;
      snapAnimRef.current?.stop();
      snapAnimRef.current = null;
      snappingRef.current = false;
      snapTargetRef.current = null;
      isDraggingRef.current = false;
      isResizingRef.current = false;
    };
  }, []);

  const shouldSuppressExpand = useCallback((): boolean => {
    const until = suppressExpandUntilRef.current;
    suppressExpandUntilRef.current = 0;
    return Date.now() < until;
  }, []);

  const beginPointerSession = useCallback((): WebWindowEvents | null => {
    if (stateRef.current.isTv) return null;
    const win = readWebWindow();
    if (win === null) return null;
    cleanupListenersRef.current?.();
    snapAnimRef.current?.stop();
    snapAnimRef.current = null;
    snappingRef.current = false;
    snapTargetRef.current = null;
    return win;
  }, []);

  const startDrag = useCallback(
    (startX: number, startY: number): void => {
      const win = beginPointerSession();
      if (win === null) return;

      const startLeft = stateRef.current.effectivePos.left;
      const startTop = stateRef.current.effectivePos.top;
      let curLeft = startLeft;
      let curTop = startTop;
      let lastX = startX;
      let lastY = startY;
      let lastTime = Date.now();
      let vx = 0;
      let vy = 0;
      let maxDist = 0;
      let cleanup: (() => void) | undefined;
      isDraggingRef.current = true;

      const handleMove = (event: unknown) => {
        const coords = extractPointerCoords(event);
        if (coords === null) return;
        const dx = coords.clientX - startX;
        const dy = coords.clientY - startY;
        maxDist = Math.max(maxDist, Math.hypot(dx, dy));
        const now = Date.now();
        const dt = Math.max(1, now - lastTime);
        vx = (coords.clientX - lastX) / dt;
        vy = (coords.clientY - lastY) / dt;
        lastX = coords.clientX;
        lastY = coords.clientY;
        lastTime = now;
        curLeft = startLeft + dx;
        curTop = startTop + dy;
        animPos.setValue({ x: curLeft, y: curTop });
      };

      const handleEnd = () => {
        cleanup?.();
        isDraggingRef.current = false;
        if (maxDist >= MINI_PLAYER_DRAG_THRESHOLD_PX) {
          suppressExpandUntilRef.current = Date.now() + SUPPRESS_EXPAND_WINDOW_MS;
        }
        const cur = stateRef.current;
        const nextCorner = snapToNearestCorner(
          curLeft,
          curTop,
          vx,
          vy,
          cur.width,
          cur.height,
          cur.bounds,
        );
        const target = computeCornerPosition(nextCorner, cur.width, cur.height, cur.bounds);
        setFreePos(null);
        if (cur.reduceMotion) {
          snappingRef.current = false;
          snapTargetRef.current = null;
          setCorner(nextCorner);
          animPos.setValue({ x: target.left, y: target.top });
        } else {
          snappingRef.current = true;
          snapTargetRef.current = target;
          setCorner(nextCorner);
          const anim = Animated.timing(animPos, {
            toValue: { x: target.left, y: target.top },
            duration: MINI_PLAYER_SNAP_DURATION_MS,
            useNativeDriver: false,
          });
          snapAnimRef.current = anim;
          anim.start(() => {
            if (snapAnimRef.current === anim) {
              snapAnimRef.current = null;
              snappingRef.current = false;
              snapTargetRef.current = null;
            }
          });
        }
      };

      cleanup = subscribeWebPointerSession(win, handleMove, handleEnd, cleanupListenersRef);
    },
    [animPos, beginPointerSession],
  );

  const startResize = useCallback(
    (edge: MiniPlayerResizeEdge, startX: number, startY: number): void => {
      const win = beginPointerSession();
      if (win === null) return;

      const startRect: MiniPlayerRect = {
        x: stateRef.current.effectivePos.left,
        y: stateRef.current.effectivePos.top,
        width: stateRef.current.width,
        height: stateRef.current.height,
      };
      let cleanup: (() => void) | undefined;
      isResizingRef.current = true;

      const handleMove = (event: unknown) => {
        const coords = extractPointerCoords(event);
        if (coords === null) return;
        const dx = coords.clientX - startX;
        const dy = coords.clientY - startY;
        const cur = stateRef.current;
        const next = computeEdgeResizedMiniBounds(startRect, edge, dx, dy, {
          width: cur.viewportWidth,
          height: cur.viewportHeight,
          safeArea: cur.safeArea,
          overscan: cur.overscan,
          isPortraitPhone: cur.isPortraitPhone,
          isTv: cur.isTv,
        });
        setCustomWidth(next.width);
        setFreePos({ left: next.x, top: next.y });
        animPos.setValue({ x: next.x, y: next.y });
      };

      const handleEnd = () => {
        cleanup?.();
        isResizingRef.current = false;
        suppressExpandUntilRef.current = Date.now() + SUPPRESS_EXPAND_WINDOW_MS;
      };

      cleanup = subscribeWebPointerSession(win, handleMove, handleEnd, cleanupListenersRef);
    },
    [animPos, beginPointerSession],
  );

  return {
    corner,
    width,
    height,
    left: effectivePos.left,
    top: effectivePos.top,
    animPos,
    startDrag,
    startResize,
    shouldSuppressExpand,
  };
}

/** Props of {@link FloatingMiniPlayerChrome}. */
export interface FloatingMiniPlayerChromeProps {
  readonly title: string;
  readonly subtitle?: string | null | undefined;
  readonly isLive: boolean;
  readonly isTv: boolean;
  readonly corner?: MiniPlayerCorner;
  readonly i18n: AppI18n;
  readonly onExpand: () => void;
  readonly onClose: () => void;
  readonly onDragStart?: ((clientX: number, clientY: number) => void) | undefined;
  readonly onResizeStart?:
    | ((edge: MiniPlayerResizeEdge, clientX: number, clientY: number) => void)
    | undefined;
  readonly shouldSuppressExpand?: (() => boolean) | undefined;
}

interface ResizeZoneSpec {
  readonly edge: MiniPlayerResizeEdge;
  readonly style: ViewStyle;
}

const EDGE = RESIZE_EDGE_THICKNESS;
const CORNER = RESIZE_CORNER_SIZE;
const RESIZE_ZONES: readonly ResizeZoneSpec[] = (
  [
    ['n', { top: 0, left: 0, right: 0, height: EDGE, zIndex: 4 }],
    ['s', { bottom: 0, left: 0, right: 0, height: EDGE, zIndex: 4 }],
    ['w', { top: 0, bottom: 0, left: 0, width: EDGE, zIndex: 4 }],
    ['e', { top: 0, bottom: 0, right: 0, width: EDGE, zIndex: 4 }],
    ['nw', { top: 0, left: 0, width: CORNER, height: CORNER, zIndex: 5 }],
    ['ne', { top: 0, right: 0, width: CORNER, height: CORNER, zIndex: 5 }],
    ['sw', { bottom: 0, left: 0, width: CORNER, height: CORNER, zIndex: 5 }],
    ['se', { bottom: 0, right: 0, width: CORNER, height: CORNER, zIndex: 5 }],
  ] as ReadonlyArray<readonly [MiniPlayerResizeEdge, ViewStyle]>
).map(([edge, box]) => ({ edge, style: { position: 'absolute', ...box } }));

/**
 * Cinema Quietude v2 floating corner mini-player overlay controls (`#233`):
 * compact channel title pill, draggable surface, 8 invisible OS edge/corner resize zones,
 * and accessible Expand & Close actions layered over the non-focusable persistent video surface.
 */
export function FloatingMiniPlayerChrome({
  title,
  subtitle,
  isLive,
  isTv,
  corner: _corner = 'bottom-right',
  i18n,
  onExpand,
  onClose,
  onDragStart,
  onResizeStart,
  shouldSuppressExpand,
}: FloatingMiniPlayerChromeProps): ReactElement {
  const theme = useTheme();
  const [focusedButton, setFocusedButton] = useState<'expand' | 'close' | null>(null);
  const pointer = !isTv ? webCursorPointer() : undefined;
  const transition = webTransition(theme, 'background-color, border-color, opacity');
  const isWeb = (Platform.OS as string) === 'web';

  const handleSurfacePointerDown = (event: unknown) => {
    if (isTv || !onDragStart) return;
    const coords = extractPointerCoords(event);
    if (coords !== null) onDragStart(coords.clientX, coords.clientY);
  };

  const handleResizePointerDown = (edge: MiniPlayerResizeEdge, event: unknown) => {
    if (isTv || !onResizeStart) return;
    const e = event as { stopPropagation?: () => void; preventDefault?: () => void } | null;
    e?.stopPropagation?.();
    e?.preventDefault?.();
    const coords = extractPointerCoords(event);
    if (coords !== null) onResizeStart(edge, coords.clientX, coords.clientY);
  };

  const handleSurfacePress = () => {
    if (shouldSuppressExpand?.() === true) return;
    onExpand();
  };

  const renderControlStyle = (kind: 'expand' | 'close', pressed: boolean) => {
    const focused = focusedButton === kind;
    return [
      styles.iconButton,
      transition,
      pointer,
      {
        borderRadius: theme.radius.pill,
        backgroundColor: focused || pressed ? theme.colors.focusFill : theme.colors.glassBg,
        borderColor: focused ? theme.colors.focusRingColor : theme.colors.glassBorder,
        borderWidth: focused ? theme.focus.ringWidth : 1,
      },
      webBackdropBlur(12),
    ];
  };

  const usePointerEvents = supportsPointerEvents();

  const dragPointerProps =
    !isTv && onDragStart !== undefined
      ? ((usePointerEvents
          ? { onPointerDown: handleSurfacePointerDown }
          : { onMouseDown: handleSurfacePointerDown }) as Record<string, unknown>)
      : {};

  return (
    <View testID="mini-player-chrome" pointerEvents="box-none" style={styles.overlay}>
      <View testID="mini-player-top-row" style={styles.topRow} pointerEvents="box-none">
        <Pressable
          testID="mini-player-surface-tap"
          accessibilityRole="button"
          accessibilityLabel={i18n.t('player.miniPlayer.expand')}
          focusable={false}
          accessible={!isTv}
          onPress={handleSurfacePress}
          style={styles.overlay}
          {...dragPointerProps}
        />
        <View testID="mini-player-actions-row" style={styles.actionsRow}>
          <Tooltip content={i18n.t('player.miniPlayer.expand')} placement="top" disabled={isTv}>
            <Pressable
              testID="mini-player-expand"
              accessibilityRole="button"
              accessibilityLabel={i18n.t('player.miniPlayer.expand')}
              hitSlop={4}
              onFocus={() => setFocusedButton('expand')}
              onBlur={() => setFocusedButton((prev) => (prev === 'expand' ? null : prev))}
              onPress={onExpand}
              style={({ pressed }) => renderControlStyle('expand', pressed)}
            >
              <Icon name="fullscreen" size={18} color={theme.colors.textPrimary} />
            </Pressable>
          </Tooltip>
          <Tooltip content={i18n.t('player.miniPlayer.close')} placement="top" disabled={isTv}>
            <Pressable
              testID="mini-player-close"
              accessibilityRole="button"
              accessibilityLabel={i18n.t('player.miniPlayer.close')}
              hitSlop={4}
              onFocus={() => setFocusedButton('close')}
              onBlur={() => setFocusedButton((prev) => (prev === 'close' ? null : prev))}
              onPress={onClose}
              style={({ pressed }) => renderControlStyle('close', pressed)}
            >
              <Icon name="close" size={18} color={theme.colors.textPrimary} />
            </Pressable>
          </Tooltip>
        </View>
      </View>

      <Tooltip
        content={i18n.t('player.mini.drag')}
        placement="bottom"
        disabled={isTv || onDragStart === undefined}
      >
        <View
          testID="mini-player-title-bar"
          style={[
            styles.titleBar,
            {
              backgroundColor: theme.colors.glassBg,
              borderTopColor: theme.colors.glassBorder,
            },
            webBackdropBlur(14),
          ]}
          {...dragPointerProps}
        >
          {isLive ? (
            <View
              testID="mini-player-live-dot"
              style={[styles.liveDot, { backgroundColor: theme.colors.liveColor }]}
            />
          ) : null}
          <View style={styles.titleStack}>
            <Text
              testID="mini-player-title"
              numberOfLines={1}
              style={[
                theme.typography.caption,
                styles.titleText,
                { color: theme.colors.textPrimary },
              ]}
            >
              {title}
            </Text>
            {subtitle !== undefined && subtitle !== null && subtitle.trim().length > 0 ? (
              <Text
                numberOfLines={1}
                style={[theme.typography.micro, { color: theme.colors.textSecondary }]}
              >
                {subtitle}
              </Text>
            ) : null}
          </View>
        </View>
      </Tooltip>

      {!isTv
        ? RESIZE_ZONES.map((zone) => {
            const resizeProps = (
              usePointerEvents
                ? { onPointerDown: (ev: unknown) => handleResizePointerDown(zone.edge, ev) }
                : { onMouseDown: (ev: unknown) => handleResizePointerDown(zone.edge, ev) }
            ) as Record<string, unknown>;
            const cursorStyle = isWeb
              ? ({ cursor: resizeCursorForEdge(zone.edge) } as unknown as ViewStyle)
              : undefined;
            return (
              <Pressable
                key={zone.edge}
                testID={`mini-player-resize-${zone.edge}`}
                focusable={false}
                accessible={false}
                style={[zone.style, cursorStyle]}
                {...resizeProps}
              />
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: 'space-between',
  },
  topRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
    padding: 8,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    zIndex: 6,
  },
  iconButton: {
    width: 40,
    height: 40,
    minWidth: 40,
    minHeight: 40,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    flexShrink: 0,
  },
  titleStack: {
    flex: 1,
    minWidth: 0,
  },
  titleText: {
    fontWeight: '600',
  },
});
