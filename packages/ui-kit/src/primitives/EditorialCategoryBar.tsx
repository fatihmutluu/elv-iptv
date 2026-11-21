import {
  type ComponentRef,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { useI18n } from '../i18n';
import { Icon } from '../icons';
import { useTheme, webBackdropBlur, webCursorPointer, webShadow, webTransition } from '../theme';
import { useViewport } from '../viewport';
import { HorizontalRailScroll } from './HorizontalRailScroll';

/** Single category entry rendered inside {@link EditorialCategoryBar}. */
export interface EditorialCategoryItem {
  readonly id: string;
  readonly label: string;
  readonly testID?: string;
}

/** Props of {@link EditorialCategoryBar}. */
export interface EditorialCategoryBarProps {
  readonly items: readonly EditorialCategoryItem[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly focusedIndex?: number | null;
  readonly isTv?: boolean;
  readonly padX?: number;
  readonly testID?: string;
  readonly pickerLabel?: string;
  readonly pickerThreshold?: number;
  readonly rightAccessory?: ReactNode;
}

type TabLayout = { readonly x: number; readonly width: number };

interface WebKeydownWindow {
  addEventListener(type: 'keydown', listener: (e: { key?: string }) => void): void;
  removeEventListener(type: 'keydown', listener: (e: { key?: string }) => void): void;
}

const WEB_BACKDROP_STYLE = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  zIndex: 19,
} as unknown as ViewStyle;

/**
 * Borderless editorial underline category bar replacing pill-bubble category chips.
 * Pairs a crisp `1px` bottom hairline and `2px` accent active bar with optional 1-click
 * category dropdown jumping for long IPTV category lists on non-TV viewports.
 */
export function EditorialCategoryBar({
  items,
  activeId,
  onSelect,
  focusedIndex,
  isTv,
  padX = 0,
  testID,
  pickerLabel,
  pickerThreshold = 6,
  rightAccessory,
}: EditorialCategoryBarProps): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const resolvedIsTv = isTv ?? viewport.inputModality === 'tv';
  const tabGap = viewport.orientation === 'portrait' && !resolvedIsTv ? 16 : 20;

  const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const tabLayoutsRef = useRef<Record<number, TabLayout>>({});
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pickerHovered, setPickerHovered] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const showPicker = !resolvedIsTv && Boolean(pickerLabel) && items.length > pickerThreshold;

  useEffect(() => {
    if (focusedIndex === null || focusedIndex === undefined) return;
    const layout = tabLayoutsRef.current[focusedIndex];
    if (!layout) return;
    scrollRef.current?.scrollTo({ x: Math.max(0, layout.x - 48), animated: !theme.reduceMotion });
  }, [focusedIndex, theme.reduceMotion]);

  useEffect(() => {
    if (!pickerOpen || Platform.OS !== 'web') return;
    const win = (globalThis as { window?: WebKeydownWindow }).window;
    if (!win?.addEventListener) return;
    const onKeyDown = (event: { key?: string }) => {
      if (event.key === 'Escape') setPickerOpen(false);
    };
    win.addEventListener('keydown', onKeyDown);
    return () => win.removeEventListener('keydown', onKeyDown);
  }, [pickerOpen]);

  const handleTabLayout = useCallback((index: number, event: LayoutChangeEvent) => {
    tabLayoutsRef.current[index] = {
      x: event.nativeEvent.layout.x,
      width: event.nativeEvent.layout.width,
    };
  }, []);

  const handleSelectFromPicker = useCallback(
    (id: string) => {
      setPickerOpen(false);
      onSelect(id);
    },
    [onSelect],
  );

  const transition = webTransition(theme, 'color, background-color, border-color, opacity');
  const cursor = webCursorPointer();
  const menuBlur = webBackdropBlur(16);
  const pickerTone =
    pickerOpen || pickerHovered ? theme.colors.textPrimary : theme.colors.textSecondary;

  return (
    <View
      testID={testID}
      style={[
        styles.container,
        {
          borderBottomColor: theme.colors.surfaceBorder,
          paddingHorizontal: padX,
          zIndex: pickerOpen ? 30 : 10,
        },
      ]}
    >
      <View style={styles.railSlot}>
        <HorizontalRailScroll
          scrollRef={scrollRef}
          wheelPanVertical
          showArrows
          isTv={resolvedIsTv}
          testID={testID ? `${testID}-rail` : undefined}
          contentContainerStyle={[styles.tabRow, { gap: tabGap }]}
        >
          {items.map((item, index) => {
            const isActive = item.id === activeId;
            const isHovered = hoveredId === item.id;
            const tabTestId = item.testID ?? (testID ? `${testID}-tab-${item.id}` : undefined);
            return (
              <Pressable
                key={item.id}
                testID={tabTestId}
                accessibilityRole="tab"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: isActive }}
                focusable={!resolvedIsTv}
                onPress={() => onSelect(item.id)}
                onLayout={(event) => handleTabLayout(index, event)}
                onHoverIn={() => setHoveredId(item.id)}
                onHoverOut={() => setHoveredId((prev) => (prev === item.id ? null : prev))}
                style={(state) => {
                  const isTvFocused =
                    resolvedIsTv && (focusedIndex === index || Boolean(state.focused));
                  return [
                    styles.tab,
                    isTvFocused
                      ? {
                          backgroundColor: theme.colors.focusFill,
                          borderRadius: theme.radius.button,
                        }
                      : styles.tabUnfocused,
                    transition,
                    cursor,
                  ];
                }}
              >
                {({ focused: stateFocused }) => {
                  const isTvFocused = resolvedIsTv && (focusedIndex === index || stateFocused);
                  const textColor =
                    isActive || isHovered || isTvFocused
                      ? theme.colors.textPrimary
                      : theme.colors.textSecondary;
                  return (
                    <>
                      <Text
                        numberOfLines={1}
                        style={[
                          theme.typography.caption,
                          { color: textColor, fontWeight: isActive ? '600' : '500' },
                        ]}
                      >
                        {item.label}
                      </Text>
                      {isActive ? (
                        <View
                          pointerEvents="none"
                          testID={testID ? `${testID}-active-bar-${item.id}` : undefined}
                          style={[styles.activeBar, { backgroundColor: theme.colors.accent }]}
                        />
                      ) : null}
                      {isTvFocused ? (
                        <View
                          pointerEvents="none"
                          testID={tabTestId ? `${tabTestId}-focus-ring` : undefined}
                          style={[
                            styles.focusRing,
                            {
                              borderRadius: theme.radius.button,
                              borderWidth: theme.focus.ringWidth,
                              borderColor: theme.colors.focusRingColor,
                            },
                          ]}
                        />
                      ) : null}
                    </>
                  );
                }}
              </Pressable>
            );
          })}
        </HorizontalRailScroll>
      </View>

      {showPicker || rightAccessory ? (
        <View style={styles.rightCluster}>
          {showPicker ? (
            <Pressable
              testID={testID ? `${testID}-picker-trigger` : undefined}
              accessibilityRole="button"
              accessibilityLabel={pickerLabel}
              accessibilityState={{ expanded: pickerOpen }}
              onPress={() => setPickerOpen((prev) => !prev)}
              onHoverIn={() => setPickerHovered(true)}
              onHoverOut={() => setPickerHovered(false)}
              style={[
                styles.pickerTrigger,
                {
                  borderRadius: theme.radius.button,
                  backgroundColor:
                    pickerOpen || pickerHovered ? theme.colors.subtleHighlight : 'transparent',
                },
                transition,
                cursor,
              ]}
            >
              <Text
                numberOfLines={1}
                style={[theme.typography.caption, { color: pickerTone, fontWeight: '500' }]}
              >
                {pickerLabel}
              </Text>
              <Icon name="chevronDown" size={14} color={pickerTone} />
            </Pressable>
          ) : null}
          {rightAccessory}
        </View>
      ) : null}

      {pickerOpen && showPicker ? (
        <>
          <Pressable
            testID={testID ? `${testID}-picker-backdrop` : undefined}
            accessibilityRole="button"
            accessibilityLabel={i18n.t('ui.dismiss')}
            onPress={() => setPickerOpen(false)}
            style={Platform.OS === 'web' ? WEB_BACKDROP_STYLE : styles.backdrop}
          />
          <View
            testID={testID ? `${testID}-picker-menu` : undefined}
            style={[
              styles.dropdown,
              {
                backgroundColor: theme.colors.bgElevated,
                borderColor: theme.colors.glassBorder,
                borderRadius: theme.radius.card,
                right: padX,
              },
              menuBlur,
              webShadow('0 14px 36px rgba(0, 0, 0, 0.55)'),
            ]}
          >
            <ScrollView style={styles.dropdownScroll} showsVerticalScrollIndicator>
              {items.map((item) => {
                const isActive = item.id === activeId;
                return (
                  <Pressable
                    key={item.id}
                    testID={testID ? `${testID}-picker-item-${item.id}` : undefined}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isActive }}
                    onPress={() => handleSelectFromPicker(item.id)}
                    style={({ pressed }) => [
                      styles.dropdownItem,
                      {
                        backgroundColor: isActive
                          ? theme.colors.accentTint
                          : pressed
                            ? theme.colors.subtleHighlight
                            : 'transparent',
                      },
                      cursor,
                    ]}
                  >
                    <View
                      style={[
                        styles.dropdownActiveBar,
                        { backgroundColor: isActive ? theme.colors.accent : 'transparent' },
                      ]}
                    />
                    <Text
                      numberOfLines={1}
                      style={[
                        theme.typography.caption,
                        {
                          color: isActive ? theme.colors.textPrimary : theme.colors.textSecondary,
                          fontWeight: isActive ? '600' : '500',
                          flex: 1,
                        },
                      ]}
                    >
                      {item.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
  },
  railSlot: { flex: 1, minWidth: 0 },
  tabRow: { flexDirection: 'row', alignItems: 'center' },
  tab: {
    position: 'relative',
    minHeight: 40,
    paddingVertical: 10,
    paddingHorizontal: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tabUnfocused: { borderWidth: 0, borderColor: 'transparent' },
  focusRing: { position: 'absolute', top: 2, bottom: 2, left: -2, right: -2 },
  activeBar: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2 },
  rightCluster: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 12 },
  pickerTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  backdrop: {
    position: 'absolute',
    top: -1000,
    left: -1000,
    right: -1000,
    bottom: -1000,
    zIndex: 19,
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    marginTop: 6,
    width: 240,
    maxHeight: 340,
    borderWidth: 1,
    overflow: 'hidden',
    zIndex: 20,
  },
  dropdownScroll: { maxHeight: 340 },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  dropdownActiveBar: { width: 3, height: 16, borderRadius: 2 },
});
