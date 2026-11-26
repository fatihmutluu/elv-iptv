import {
  createContext,
  createElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BackHandler,
  Dimensions,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useUiAdapters } from '../adapters';
import { ICON_PATHS, type IconName, type IconShape } from '../icons/paths';
import type { Theme } from './tokens';
import { webBackdropBlur, webCursorPointer, webShadow, webTransition } from './web-styles';

/** Viewport edge margin in pixels when clamping anchored context menus. */
export const CONTEXT_MENU_MARGIN_PX = 12;

const DEFAULT_MENU_WIDTH_PX = 224;
const ESTIMATED_ROW_HEIGHT_PX = 38;
const ESTIMATED_HEADER_HEIGHT_PX = 48;
const MENU_PADDING_VERTICAL_PX = 12;

/** Pointer anchor coordinate in viewport pixels for floating desktop context menus. */
export interface ContextMenuAnchor {
  readonly x: number;
  readonly y: number;
}

/** Single actionable row rendered inside a context menu. */
export interface ContextMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly testID?: string;
  readonly onSelect: () => void;
}

/** Payload passed to {@link ContextMenuHostController.openContextMenu}. */
export interface ContextMenuRequest {
  readonly title?: string;
  readonly subtitle?: string;
  readonly anchor?: ContextMenuAnchor;
  readonly items: readonly ContextMenuItem[];
}

/** Root overlay host controller exposed by {@link useContextMenu}. */
export interface ContextMenuHostController {
  readonly openContextMenu: (request: ContextMenuRequest) => void;
  readonly closeContextMenu: () => void;
  readonly isOpen: boolean;
}

/** Width/height dimensions in pixels used for context menu positioning. */
export interface ContextMenuSize {
  readonly width: number;
  readonly height: number;
}

/** Computed top-left viewport coordinates for an anchored context menu. */
export interface ContextMenuPosition {
  readonly left: number;
  readonly top: number;
}

/**
 * Pure helper that places an anchored context menu inside the viewport with a margin,
 * flipping left or up when the menu would overflow the right or bottom edge.
 */
export function computeContextMenuPosition(
  anchor: ContextMenuAnchor,
  menuSize: ContextMenuSize,
  viewportSize: ContextMenuSize,
  marginPx: number = CONTEXT_MENU_MARGIN_PX,
): ContextMenuPosition {
  const safeMargin = Number.isFinite(marginPx) && marginPx >= 0 ? marginPx : CONTEXT_MENU_MARGIN_PX;
  const anchorX = Number.isFinite(anchor.x) ? anchor.x : safeMargin;
  const anchorY = Number.isFinite(anchor.y) ? anchor.y : safeMargin;
  const width = Math.max(0, Number.isFinite(menuSize.width) ? menuSize.width : 0);
  const height = Math.max(0, Number.isFinite(menuSize.height) ? menuSize.height : 0);
  const vpW = Math.max(0, Number.isFinite(viewportSize.width) ? viewportSize.width : 0);
  const vpH = Math.max(0, Number.isFinite(viewportSize.height) ? viewportSize.height : 0);

  let left = anchorX;
  if (left + width > vpW - safeMargin) {
    left = anchorX - width;
  }

  let top = anchorY;
  if (top + height > vpH - safeMargin) {
    top = anchorY - height;
  }

  const maxLeft = Math.max(safeMargin, vpW - width - safeMargin);
  const maxTop = Math.max(safeMargin, vpH - height - safeMargin);

  return {
    left: Math.round(Math.min(maxLeft, Math.max(safeMargin, left))),
    top: Math.round(Math.min(maxTop, Math.max(safeMargin, top))),
  };
}

const NOOP_CONTROLLER: ContextMenuHostController = {
  openContextMenu: () => undefined,
  closeContextMenu: () => undefined,
  isOpen: false,
};

const ContextMenuHostContext = createContext<ContextMenuHostController>(NOOP_CONTROLLER);

/** Reads the root context menu controller provided by {@link ThemeProvider}, or a safe no-op outside one. */
export function useContextMenu(): ContextMenuHostController {
  return useContext(ContextMenuHostContext);
}

const NATIVE_MENU_SHADOW: ViewStyle = {
  shadowColor: 'rgba(0, 0, 0, 1)',
  shadowOffset: { width: 0, height: 14 },
  shadowOpacity: 0.58,
  shadowRadius: 28,
  elevation: 18,
};

function getViewportSize(): ContextMenuSize {
  if (Platform.OS === 'web') {
    const win = globalThis as { innerWidth?: number; innerHeight?: number };
    if (
      typeof win.innerWidth === 'number' &&
      win.innerWidth > 0 &&
      typeof win.innerHeight === 'number' &&
      win.innerHeight > 0
    ) {
      return { width: win.innerWidth, height: win.innerHeight };
    }
  }
  const dims = Dimensions.get('window');
  return { width: dims.width || 1280, height: dims.height || 720 };
}

function findFirstEnabledIndex(items: readonly ContextMenuItem[]): number {
  return items.findIndex((item) => item.disabled !== true);
}

function findNextEnabledIndex(
  items: readonly ContextMenuItem[],
  currentIndex: number,
  step: 1 | -1,
): number {
  if (items.length === 0) return -1;
  for (let offset = 1; offset <= items.length; offset += 1) {
    const candidate = (currentIndex + step * offset + items.length) % items.length;
    if (items[candidate]?.disabled !== true) {
      return candidate;
    }
  }
  return -1;
}

function renderWebSvgShape(shape: IconShape, key: number, filled: boolean, strokeWidth: number) {
  const fill = shape.fill ?? (filled ? 'currentColor' : 'none');
  const stroke = fill === 'currentColor' ? 'none' : 'currentColor';
  const sw = shape.strokeWidth ?? strokeWidth;

  if (shape.kind === 'path') {
    return createElement('path', { key, d: shape.d, fill, stroke, strokeWidth: sw });
  }
  if (shape.kind === 'circle') {
    return createElement('circle', {
      key,
      cx: shape.cx,
      cy: shape.cy,
      r: shape.r,
      fill,
      stroke,
      strokeWidth: sw,
    });
  }
  return createElement('rect', {
    key,
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
    rx: shape.rx,
    fill,
    stroke,
    strokeWidth: sw,
  });
}

function MenuRowIcon({
  name,
  color,
}: {
  readonly name: IconName;
  readonly color: string;
}): ReactElement {
  const adapters = useUiAdapters();
  const spec = ICON_PATHS[name];
  const size = 16;
  const strokeWidth = 1.8;

  if (adapters.renderSvg) {
    return (
      <View style={styles.iconBox}>{adapters.renderSvg({ spec, size, color, strokeWidth })}</View>
    );
  }

  if (Platform.OS === 'web') {
    const filled = Boolean(spec.filled);
    return (
      <View style={styles.iconBox}>
        {createElement(
          'svg',
          {
            width: size,
            height: size,
            viewBox: spec.viewBox,
            fill: filled ? 'currentColor' : 'none',
            stroke: filled ? 'none' : 'currentColor',
            strokeWidth,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            style: { color, display: 'block' },
            'aria-hidden': true,
          },
          spec.shapes.map((shape, idx) => renderWebSvgShape(shape, idx, filled, strokeWidth)),
        )}
      </View>
    );
  }

  return <View style={[styles.iconBox, styles.nativeIconFallback, { borderColor: color }]} />;
}

interface WebKeyEventLike {
  readonly key?: string;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

interface WebEventTargetLike {
  addEventListener?: (type: string, listener: (event: WebKeyEventLike) => void) => void;
  removeEventListener?: (type: string, listener: (event: WebKeyEventLike) => void) => void;
}

/**
 * Root-level overlay host mounted inside {@link ThemeProvider} so active context menus render
 * outside `backdrop-filter`, `transform`, and `overflow: hidden` ancestors.
 */
export function ContextMenuHostProvider({
  theme,
  children,
}: {
  readonly theme: Theme;
  readonly children: ReactNode;
}): ReactElement {
  const [request, setRequest] = useState<ContextMenuRequest | null>(null);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [measuredSize, setMeasuredSize] = useState<ContextMenuSize | null>(null);

  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const requestRef = useRef(request);
  requestRef.current = request;

  const closeContextMenu = useCallback(() => {
    setRequest(null);
    setActiveIndex(-1);
    setHoveredIndex(null);
    setMeasuredSize(null);
  }, []);

  const openContextMenu = useCallback((nextRequest: ContextMenuRequest) => {
    setRequest(nextRequest);
    setActiveIndex(findFirstEnabledIndex(nextRequest.items));
    setHoveredIndex(null);
    setMeasuredSize(null);
  }, []);

  const selectItem = useCallback(
    (item: ContextMenuItem) => {
      if (item.disabled === true) return;
      closeContextMenu();
      item.onSelect();
    },
    [closeContextMenu],
  );

  // Web keyboard navigation: Escape closes, ArrowUp/ArrowDown skip disabled rows, Enter/Space activates.
  useEffect(() => {
    if (request === null || Platform.OS !== 'web') return;
    const target = globalThis as WebEventTargetLike;
    if (typeof target.addEventListener !== 'function') return;

    const handleKeyDown = (event: WebKeyEventLike) => {
      const current = requestRef.current;
      if (current === null) return;
      const key = event.key;

      if (key === 'Escape') {
        event.preventDefault?.();
        event.stopPropagation?.();
        closeContextMenu();
        return;
      }
      if (key === 'ArrowDown') {
        event.preventDefault?.();
        event.stopPropagation?.();
        const start = activeIndexRef.current < 0 ? -1 : activeIndexRef.current;
        setActiveIndex(findNextEnabledIndex(current.items, start, 1));
        return;
      }
      if (key === 'ArrowUp') {
        event.preventDefault?.();
        event.stopPropagation?.();
        const start = Math.max(activeIndexRef.current, 0);
        setActiveIndex(findNextEnabledIndex(current.items, start, -1));
        return;
      }
      if (key === 'Enter' || key === ' ') {
        const idx = activeIndexRef.current;
        const item = idx >= 0 ? current.items[idx] : undefined;
        if (item && item.disabled !== true) {
          event.preventDefault?.();
          event.stopPropagation?.();
          selectItem(item);
        }
      }
    };

    target.addEventListener('keydown', handleKeyDown);
    return () => {
      target.removeEventListener?.('keydown', handleKeyDown);
    };
  }, [request, closeContextMenu, selectItem]);

  // Native Android / TV hardware back closes the context menu.
  useEffect(() => {
    if (request === null || Platform.OS === 'web') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeContextMenu();
      return true;
    });
    return () => {
      sub.remove();
    };
  }, [request, closeContextMenu]);

  const handlePanelLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setMeasuredSize((prev) =>
        prev !== null && prev.width === width && prev.height === height ? prev : { width, height },
      );
    }
  }, []);

  const controller = useMemo<ContextMenuHostController>(
    () => ({
      openContextMenu,
      closeContextMenu,
      isOpen: request !== null,
    }),
    [openContextMenu, closeContextMenu, request],
  );

  const fontFamilyStyle =
    theme.typography.title.fontFamily !== undefined
      ? { fontFamily: theme.typography.title.fontFamily }
      : undefined;
  const cursor = webCursorPointer();
  const rowTransition = webTransition(theme, 'background-color, opacity', 150);

  const isAnchoredWeb = Platform.OS === 'web' && request?.anchor !== undefined;
  const hasHeader = Boolean(request?.title?.trim() || request?.subtitle?.trim());

  const estimatedSize: ContextMenuSize = {
    width: DEFAULT_MENU_WIDTH_PX,
    height:
      (request?.items.length ?? 0) * ESTIMATED_ROW_HEIGHT_PX +
      (hasHeader ? ESTIMATED_HEADER_HEIGHT_PX : 0) +
      MENU_PADDING_VERTICAL_PX,
  };

  const anchoredPos =
    isAnchoredWeb && request?.anchor !== undefined
      ? computeContextMenuPosition(request.anchor, measuredSize ?? estimatedSize, getViewportSize())
      : null;

  const webBackdropProps =
    Platform.OS === 'web'
      ? ({
          tabIndex: -1,
          onContextMenu: (event: { preventDefault?: () => void; stopPropagation?: () => void }) => {
            event.preventDefault?.();
            event.stopPropagation?.();
            closeContextMenu();
          },
        } as Record<string, unknown>)
      : {};

  const panelElement =
    request !== null ? (
      <View
        testID="context-menu-panel"
        accessibilityRole="menu"
        onLayout={handlePanelLayout}
        style={[
          styles.panel,
          isAnchoredWeb && anchoredPos !== null
            ? ({
                position: 'fixed',
                left: anchoredPos.left,
                top: anchoredPos.top,
              } as unknown as ViewStyle)
            : styles.centeredPanel,
          NATIVE_MENU_SHADOW,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(16),
          webShadow('0 18px 44px rgba(0, 0, 0, 0.72)'),
        ]}
      >
        {hasHeader ? (
          <View
            testID="context-menu-header"
            style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}
          >
            {request.title ? (
              <Text
                numberOfLines={1}
                style={[
                  fontFamilyStyle,
                  styles.headerTitle,
                  {
                    color: theme.colors.textPrimary,
                    fontSize: Math.round(13 * theme.fontScale * 2) / 2,
                  },
                ]}
              >
                {request.title}
              </Text>
            ) : null}
            {request.subtitle ? (
              <Text
                numberOfLines={1}
                style={[
                  fontFamilyStyle,
                  styles.headerSubtitle,
                  {
                    color: theme.colors.textMuted,
                    fontSize: Math.round(11 * theme.fontScale * 2) / 2,
                  },
                ]}
              >
                {request.subtitle}
              </Text>
            ) : null}
          </View>
        ) : null}

        <View style={styles.itemList}>
          {request.items.map((item, index) => {
            const isDisabled = item.disabled === true;
            const isActive = activeIndex === index;
            const isHovered = hoveredIndex === index;
            const labelColor = item.destructive ? theme.colors.liveColor : theme.colors.textPrimary;
            const iconColor = item.destructive
              ? theme.colors.liveColor
              : theme.colors.textSecondary;
            const rowBg = isDisabled
              ? 'transparent'
              : isActive
                ? theme.colors.focusFill
                : isHovered
                  ? theme.colors.subtleHighlight
                  : 'transparent';

            return (
              <Pressable
                key={item.id}
                testID={item.testID ?? `context-menu-item-${item.id}`}
                accessibilityRole="menuitem"
                accessibilityLabel={item.label}
                focusable={!isDisabled}
                hasTVPreferredFocus={!isDisabled && isActive}
                {...(isDisabled ? { disabled: true } : {})}
                onFocus={() => {
                  if (!isDisabled) setActiveIndex(index);
                }}
                onHoverIn={() => setHoveredIndex(index)}
                onHoverOut={() => setHoveredIndex((prev) => (prev === index ? null : prev))}
                onPress={() => selectItem(item)}
                style={[
                  styles.row,
                  {
                    borderRadius: theme.radius.card,
                    backgroundColor: rowBg,
                    opacity: isDisabled ? 0.45 : 1,
                  },
                  rowTransition,
                  !isDisabled ? cursor : undefined,
                ]}
              >
                {item.icon !== undefined ? (
                  <MenuRowIcon name={item.icon} color={iconColor} />
                ) : null}
                <Text
                  numberOfLines={1}
                  style={[
                    fontFamilyStyle,
                    styles.rowLabel,
                    {
                      color: labelColor,
                      fontSize: Math.round(13 * theme.fontScale * 2) / 2,
                    },
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    ) : null;

  return (
    <ContextMenuHostContext.Provider value={controller}>
      {children}
      {request !== null ? (
        <View
          accessibilityViewIsModal
          style={[
            isAnchoredWeb
              ? ({
                  position: 'fixed',
                  top: 0,
                  right: 0,
                  bottom: 0,
                  left: 0,
                } as unknown as ViewStyle)
              : StyleSheet.absoluteFill,
            styles.overlayRoot,
            !isAnchoredWeb ? styles.centeredOverlay : undefined,
          ]}
        >
          <Pressable
            testID="context-menu-backdrop"
            focusable={false}
            accessibilityRole="button"
            onPress={closeContextMenu}
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor: isAnchoredWeb ? 'transparent' : theme.colors.overlayBackdrop,
              },
            ]}
            {...webBackdropProps}
          />
          {panelElement}
        </View>
      ) : null}
    </ContextMenuHostContext.Provider>
  );
}

const styles = StyleSheet.create({
  overlayRoot: {
    zIndex: 9998,
  },
  centeredOverlay: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  panel: {
    zIndex: 9999,
    minWidth: 210,
    maxWidth: 280,
    borderWidth: 1,
    overflow: 'hidden',
  },
  centeredPanel: {
    width: '100%',
    maxWidth: 320,
  },
  header: {
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: {
    fontWeight: '600',
    lineHeight: 18,
  },
  headerSubtitle: {
    fontWeight: '500',
    lineHeight: 15,
    marginTop: 2,
  },
  itemList: {
    padding: 6,
    gap: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    minHeight: 36,
  },
  rowLabel: {
    flex: 1,
    fontWeight: '500',
    lineHeight: 18,
  },
  iconBox: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nativeIconFallback: {
    borderWidth: 1.5,
    borderRadius: 3,
    opacity: 0.75,
  },
});
