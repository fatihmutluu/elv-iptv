import type { AppI18n } from '@elv/i18n';
import {
  type ComponentRef,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  type ScrollViewProps,
  type StyleProp,
  StyleSheet,
  View,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { useI18n } from '../i18n';
import { Icon } from '../icons';
import { useTheme, webCursorPointer, webTransition } from '../theme';
import { useViewport } from '../viewport';
import { attachHorizontalDragScroll, type HorizontalDragElementLike } from './horizontal-rail-drag';

/** Props of {@link HorizontalRailScroll}. */
export interface HorizontalRailScrollProps {
  readonly children: ReactNode;
  readonly scrollRef?: RefObject<ComponentRef<typeof ScrollView> | null>;
  readonly contentContainerStyle?: StyleProp<ViewStyle>;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
  readonly wheelPanVertical?: boolean;
  readonly showArrows?: boolean;
  readonly arrowStepRatio?: number;
  readonly isTv?: boolean;
  readonly onScroll?: ScrollViewProps['onScroll'];
  readonly scrollEventThrottle?: number;
}

function safeTranslate(i18n: AppI18n, key: string, fallback: string): string {
  const translated = (i18n.t as (id: string) => string)(key);
  return translated && translated !== key ? translated : fallback;
}

function resolveScrollableDomNode(node: unknown): HorizontalDragElementLike | null {
  if (!node || typeof node !== 'object') return null;
  const candidate =
    typeof (node as { getScrollableNode?: () => unknown }).getScrollableNode === 'function'
      ? (node as { getScrollableNode: () => unknown }).getScrollableNode()
      : node;
  return candidate &&
    typeof candidate === 'object' &&
    typeof (candidate as HorizontalDragElementLike).addEventListener === 'function'
    ? (candidate as HorizontalDragElementLike)
    : null;
}

function webHoverProps(onEnter: () => void, onLeave: () => void): Partial<ViewProps> {
  if (Platform.OS !== 'web') return {};
  return { onMouseEnter: onEnter, onMouseLeave: onLeave } as unknown as Partial<ViewProps>;
}

/**
 * Horizontal rail `ScrollView` with desktop drag-to-scroll, optional vertical wheel panning,
 * and hover-revealed edge chevron controls on web pointer viewports while preserving TV auto-scroll.
 */
export function HorizontalRailScroll({
  children,
  scrollRef,
  contentContainerStyle,
  style,
  testID,
  wheelPanVertical = false,
  showArrows = true,
  arrowStepRatio = 0.78,
  isTv,
  onScroll,
  scrollEventThrottle = 32,
}: HorizontalRailScrollProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const resolvedIsTv = isTv ?? viewport.inputModality === 'tv';
  const enablePointerWeb =
    Platform.OS === 'web' && !resolvedIsTv && viewport.inputModality === 'pointer';

  const internalRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const offsetXRef = useRef(0);
  const viewportWidthRef = useRef(0);
  const contentWidthRef = useRef(0);
  const [bounds, setBounds] = useState({ canLeft: false, canRight: false });
  const [hovered, setHovered] = useState(false);

  const updateBounds = useCallback(() => {
    const canLeft = offsetXRef.current > 2;
    const canRight =
      contentWidthRef.current > viewportWidthRef.current + 2 &&
      offsetXRef.current < contentWidthRef.current - viewportWidthRef.current - 2;
    setBounds((prev) =>
      prev.canLeft === canLeft && prev.canRight === canRight ? prev : { canLeft, canRight },
    );
  }, []);

  const setMergedRef = useCallback(
    (node: ComponentRef<typeof ScrollView> | null) => {
      internalRef.current = node;
      if (scrollRef) {
        (scrollRef as MutableRefObject<ComponentRef<typeof ScrollView> | null>).current = node;
      }
    },
    [scrollRef],
  );

  useEffect(() => {
    if (!enablePointerWeb) return;
    const domNode = resolveScrollableDomNode(internalRef.current);
    return domNode ? attachHorizontalDragScroll(domNode, { wheelPanVertical }) : undefined;
  }, [enablePointerWeb, wheelPanVertical]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportWidthRef.current = event.nativeEvent.layout.width;
      updateBounds();
    },
    [updateBounds],
  );

  const handleContentSizeChange = useCallback(
    (contentWidth: number) => {
      contentWidthRef.current = contentWidth;
      updateBounds();
    },
    [updateBounds],
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      offsetXRef.current = contentOffset.x;
      if (layoutMeasurement.width > 0) viewportWidthRef.current = layoutMeasurement.width;
      if (contentSize.width > 0) contentWidthRef.current = contentSize.width;
      updateBounds();
      onScroll?.(event);
    },
    [onScroll, updateBounds],
  );

  const scrollByDirection = useCallback(
    (direction: -1 | 1) => {
      const step = Math.max(120, Math.round(viewportWidthRef.current * arrowStepRatio));
      const maxOffset = Math.max(0, contentWidthRef.current - viewportWidthRef.current);
      const nextX = Math.max(0, Math.min(maxOffset, offsetXRef.current + direction * step));
      internalRef.current?.scrollTo({ x: nextX, animated: !theme.reduceMotion });
    },
    [arrowStepRatio, theme.reduceMotion],
  );

  const handleEnter = useCallback(() => setHovered(true), []);
  const handleLeave = useCallback(() => setHovered(false), []);
  const fadeTransition = webTransition(theme, 'opacity');
  const cursor = webCursorPointer();
  const renderArrows = enablePointerWeb && showArrows;

  const renderEdgeArrow = (side: 'left' | 'right') => {
    const isLeft = side === 'left';
    const label = safeTranslate(
      i18n,
      isLeft ? 'rail.scrollLeft' : 'rail.scrollRight',
      isLeft ? 'Scroll left' : 'Scroll right',
    );
    return (
      <Pressable
        testID={testID ? `${testID}-scroll-${side}` : undefined}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => scrollByDirection(isLeft ? -1 : 1)}
        style={({ pressed, focused }) => [
          styles.edgeButton,
          isLeft ? styles.edgeLeft : styles.edgeRight,
          {
            backgroundColor: theme.colors.scrimStrong,
            opacity: hovered || focused || pressed ? 0.94 : 0,
          },
          fadeTransition,
          cursor,
        ]}
      >
        <Icon
          name={isLeft ? 'chevronLeft' : 'chevronRight'}
          size={22}
          color={theme.colors.textPrimary}
        />
      </Pressable>
    );
  };

  return (
    <View
      testID={testID}
      style={[styles.wrapper, style]}
      {...webHoverProps(handleEnter, handleLeave)}
    >
      <ScrollView
        ref={setMergedRef}
        testID={testID ? `${testID}-scroll` : undefined}
        horizontal
        showsHorizontalScrollIndicator={false}
        {...(resolvedIsTv ? { focusable: false } : {})}
        contentContainerStyle={contentContainerStyle}
        onLayout={handleLayout}
        onContentSizeChange={handleContentSizeChange}
        onScroll={handleScroll}
        scrollEventThrottle={scrollEventThrottle}
      >
        {children}
      </ScrollView>
      {renderArrows && bounds.canLeft ? renderEdgeArrow('left') : null}
      {renderArrows && bounds.canRight ? renderEdgeArrow('right') : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: 'relative' },
  edgeButton: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 4,
  },
  edgeLeft: { left: 0 },
  edgeRight: { right: 0 },
});
