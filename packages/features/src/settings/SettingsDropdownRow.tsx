import type { KeyInput } from '@elv/focus-core';
import {
  Icon,
  TABULAR_NUMS_STYLE,
  Tooltip,
  useI18n,
  useTheme,
  useTvKeyInterceptor,
  webBackdropBlur,
  webCursorPointer,
  webShadow,
  webTransition,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  computeDropdownPopoverPlacement,
  type DropdownPopoverPlacement,
  measureNodeRect,
  useSettingsOverlayPortal,
} from './SettingsOverlayPortal';

/** Single selectable option rendered inside {@link SettingsDropdownRow}. */
export interface SettingsDropdownOption<T> {
  readonly value: T;
  readonly label: string;
  readonly testID?: string;
}

/** Props of {@link SettingsDropdownRow}. */
export interface SettingsDropdownRowProps<T> {
  readonly testID: string;
  readonly title: string;
  readonly description?: string;
  readonly options: readonly SettingsDropdownOption<T>[];
  readonly selectedValue: T;
  /** Optional display fallback when `selectedValue` is a legacy value not present in `options`. */
  readonly fallbackLabel?: string;
  readonly focused?: boolean;
  readonly isTv: boolean;
  readonly tabularNums?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: (value: T) => void;
  /** Optional right-side inline accessory (e.g. "Refresh now" button). */
  readonly accessory?: ReactElement;
  /** Controlled open state (used for sibling coordination and 10-ft TV D-pad activation). */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onLayoutY?: (y: number) => void;
}

function TvDropdownKeyTrap({
  count,
  highlightedIndexRef,
  onMove,
  onConfirm,
  onClose,
}: {
  readonly count: number;
  readonly highlightedIndexRef: { readonly current: number };
  readonly onMove: (next: number) => void;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): null {
  const stateRef = useRef({ count, highlightedIndexRef, onMove, onConfirm, onClose });
  stateRef.current = { count, highlightedIndexRef, onMove, onConfirm, onClose };

  const handleInput = useCallback((input: KeyInput): boolean => {
    const {
      count: total,
      highlightedIndexRef: idxRef,
      onMove: move,
      onConfirm: confirm,
      onClose: close,
    } = stateRef.current;
    if (input.action === 'up' || input.action === 'cancel') return true;
    const cur = idxRef.current;
    if (input.key === 'up') {
      move(Math.max(0, cur - 1));
      return true;
    }
    if (input.key === 'down') {
      move(Math.min(Math.max(0, total - 1), cur + 1));
      return true;
    }
    if (input.key === 'select') {
      confirm();
      return true;
    }
    if (input.key === 'back') {
      close();
      return true;
    }
    return true;
  }, []);

  useTvKeyInterceptor(handleInput);
  return null;
}

/**
 * Cinema Quietude v2 scalable dropdown picker row for Settings:
 * - 10-ft TV (`isTv`): viewport-centered focus-trapped selection sheet rendered in the
 *   `SettingsScreen` root overlay outlet above `ScrollView`, dimming sidebar and header cleanly.
 * - Mobile / Tablet native (`!isTv && Platform.OS !== 'web'`): centered selection sheet over a
 *   full-viewport root dismiss backdrop so outside taps always dismiss on Android & iOS.
 * - Desktop / Web (`!isTv && Platform.OS === 'web'`): smart upward/downward popover rendered in
 *   the `SettingsScreen` root overlay outlet (with standalone inline fallback for isolated tests).
 */
export function SettingsDropdownRow<T>({
  testID,
  title,
  description,
  options,
  selectedValue,
  fallbackLabel,
  focused = false,
  isTv,
  tabularNums = false,
  disabled = false,
  onSelect,
  accessory,
  open: controlledOpen,
  onOpenChange,
  onLayoutY,
}: SettingsDropdownRowProps<T>): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const portal = useSettingsOverlayPortal();
  const overlayId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tvHighlightedIndex, setTvHighlightedIndex] = useState(0);
  const [webPlacement, setWebPlacement] = useState<DropdownPopoverPlacement | null>(null);
  const tvHighlightedIndexRef = useRef(0);
  const containerRef = useRef<ComponentRef<typeof View>>(null);
  const menuRef = useRef<ComponentRef<typeof View>>(null);

  const isOpen = controlledOpen ?? uncontrolledOpen;
  const isWeb = Platform.OS === 'web';
  const hasPortal = portal !== null;

  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );

  const selectedIndex = options.findIndex((opt) => opt.value === selectedValue);
  const displayLabel =
    selectedIndex >= 0
      ? (options[selectedIndex]?.label ?? '')
      : (fallbackLabel ?? String(selectedValue));

  useEffect(() => {
    if (isOpen) {
      const initial = Math.max(selectedIndex, 0);
      tvHighlightedIndexRef.current = initial;
      setTvHighlightedIndex(initial);
    } else {
      setHoveredIdx(null);
      setWebPlacement(null);
    }
  }, [isOpen, selectedIndex]);

  const handleMoveTvHighlight = useCallback((next: number) => {
    tvHighlightedIndexRef.current = next;
    setTvHighlightedIndex(next);
  }, []);

  useEffect(() => {
    if (!isOpen || isTv || !isWeb) return undefined;
    const recompute = () => {
      const triggerRect = measureNodeRect(containerRef.current);
      if (triggerRect === null) {
        setWebPlacement(null);
        return;
      }
      const hostRect = portal?.measureHost() ?? null;
      if (hostRect !== null) {
        setWebPlacement(computeDropdownPopoverPlacement(triggerRect, hostRect, options.length));
        return;
      }
      const winObj = (globalThis as { window?: { innerWidth?: number; innerHeight?: number } })
        .window;
      const winW = winObj?.innerWidth ?? 0;
      const winH = winObj?.innerHeight ?? 0;
      setWebPlacement(
        winW > 0 && winH > 0
          ? computeDropdownPopoverPlacement(
              triggerRect,
              { x: 0, y: 0, width: winW, height: winH },
              options.length,
            )
          : null,
      );
    };
    recompute();
    const win = (
      globalThis as {
        window?: {
          addEventListener?: (type: string, fn: (ev: unknown) => void, capture?: boolean) => void;
          removeEventListener?: (
            type: string,
            fn: (ev: unknown) => void,
            capture?: boolean,
          ) => void;
        };
      }
    ).window;
    if (typeof win?.addEventListener !== 'function') return undefined;

    const handleKeyDown = (ev: unknown) => {
      if ((ev as { key?: string } | null)?.key === 'Escape') setOpen(false);
    };
    const handlePointerDown = (ev: unknown) => {
      const target = (ev as { target?: unknown } | null)?.target;
      const host = containerRef.current as unknown as { contains?: (n: unknown) => boolean } | null;
      const menu = menuRef.current as unknown as { contains?: (n: unknown) => boolean } | null;
      if (host?.contains?.(target) || menu?.contains?.(target)) return;
      setOpen(false);
    };

    win.addEventListener('keydown', handleKeyDown);
    win.addEventListener('pointerdown', handlePointerDown, true);
    win.addEventListener('resize', recompute);
    win.addEventListener('scroll', recompute, true);
    return () => {
      win.removeEventListener?.('keydown', handleKeyDown);
      win.removeEventListener?.('pointerdown', handlePointerDown, true);
      win.removeEventListener?.('resize', recompute);
      win.removeEventListener?.('scroll', recompute, true);
    };
  }, [isOpen, isTv, isWeb, options.length, portal, setOpen]);

  const handleChoose = useCallback(
    (value: T) => {
      onSelect(value);
      setOpen(false);
    },
    [onSelect, setOpen],
  );

  const handleConfirmTv = useCallback(() => {
    const picked = options[tvHighlightedIndexRef.current];
    if (picked !== undefined) onSelect(picked.value);
    setOpen(false);
  }, [onSelect, options, setOpen]);

  const blur = webBackdropBlur(10);
  const menuBlur = webBackdropBlur(14);
  const cursor = disabled ? undefined : webCursorPointer();
  const transition = webTransition(theme, 'transform, background-color, border-color, opacity');
  const triggerFocused = isTv && focused && !isOpen;
  const selectHint = i18n.t('settings.dropdown.selectHint');
  const dismissLabel = i18n.t('ui.dismiss');

  const overlayNode = useMemo<ReactElement | null>(() => {
    if (!isOpen) return null;

    const isNativeSheet = !isTv && !isWeb && hasPortal;
    const isSheet = isTv || isNativeSheet;
    const rootStyle = hasPortal
      ? isSheet
        ? styles.sheetOverlayRoot
        : StyleSheet.absoluteFill
      : styles.inlineAnchor;
    const backdropStyle = [
      hasPortal
        ? StyleSheet.absoluteFill
        : isTv
          ? styles.tvBackdropInline
          : styles.dismissBackdropInline,
      isSheet ? { backgroundColor: theme.colors.overlayBackdrop } : undefined,
    ];

    const panelPositionStyle = isTv
      ? hasPortal
        ? styles.tvSheetPortal
        : styles.tvSheetInline
      : isNativeSheet
        ? styles.nativeSheetPortal
        : hasPortal
          ? webPlacement !== null
            ? {
                ...(webPlacement.top !== undefined ? { top: webPlacement.top } : {}),
                ...(webPlacement.bottom !== undefined ? { bottom: webPlacement.bottom } : {}),
                right: webPlacement.right,
                maxHeight: webPlacement.maxHeight,
              }
            : styles.menuPopoverPortalFallback
          : webPlacement?.direction === 'up'
            ? styles.menuPopoverInlineUp
            : styles.menuPopoverInline;

    return (
      <View accessibilityViewIsModal={isTv && hasPortal} pointerEvents="box-none" style={rootStyle}>
        <Pressable
          testID={`${testID}-backdrop`}
          accessibilityRole="button"
          accessibilityLabel={dismissLabel}
          focusable={false}
          onPress={() => setOpen(false)}
          style={backdropStyle}
        />
        <View
          ref={menuRef}
          testID={isTv ? `${testID}-tv-modal` : `${testID}-menu`}
          accessibilityRole={isTv ? undefined : 'menu'}
          style={[
            !isSheet && hasPortal ? styles.menuPopoverPortal : undefined,
            panelPositionStyle,
            menuBlur,
            webShadow(isTv ? '0 24px 64px rgba(0, 0, 0, 0.8)' : '0 18px 42px rgba(0, 0, 0, 0.55)'),
            {
              borderRadius: isSheet ? theme.radius.modal : theme.radius.button,
              backgroundColor: isTv ? theme.colors.glassBg : theme.colors.bgElevated,
              borderColor: isTv ? theme.colors.glassBorder : theme.colors.surfaceBorder,
              ...(isSheet
                ? {
                    padding: theme.spacing.md,
                    gap: isTv ? theme.spacing.sm : theme.spacing.xs,
                  }
                : {}),
            },
          ]}
        >
          {isSheet ? (
            <View
              style={[
                styles.sheetHeader,
                {
                  borderBottomColor: theme.colors.surfaceBorder,
                  paddingBottom: isTv ? theme.spacing.sm : theme.spacing.xs,
                },
              ]}
            >
              <Text
                numberOfLines={1}
                style={[theme.typography.title, { color: theme.colors.textPrimary }]}
              >
                {title}
              </Text>
              {isTv ? (
                <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                  {selectHint}
                </Text>
              ) : null}
            </View>
          ) : null}

          <ScrollView
            style={isTv ? styles.sheetOptionsScroll : styles.menuOptionsScroll}
            contentContainerStyle={isTv ? styles.tvOptionsList : styles.menuOptionsList}
          >
            {options.map((opt, idx) => {
              const isSelected = opt.value === selectedValue;
              const isHighlighted = isTv && tvHighlightedIndex === idx;
              const isHovered = !isTv && isWeb && hoveredIdx === idx;
              return (
                <Pressable
                  key={opt.testID ?? `${testID}-opt-${idx}`}
                  testID={opt.testID ?? `${testID}-option-${idx}`}
                  accessibilityRole="menuitem"
                  accessibilityLabel={opt.label}
                  accessibilityState={{ selected: isSelected }}
                  {...(isTv ? { focusable: false } : {})}
                  {...(!isTv && isWeb
                    ? {
                        onHoverIn: () => setHoveredIdx(idx),
                        onHoverOut: () => setHoveredIdx((cur) => (cur === idx ? null : cur)),
                      }
                    : {})}
                  onPress={() => handleChoose(opt.value)}
                  style={({ pressed }) => [
                    isTv ? styles.tvOptionRow : styles.menuOption,
                    !isTv && isWeb ? cursor : undefined,
                    transition,
                    {
                      borderRadius: theme.radius.button,
                      minHeight: isTv ? 48 : isNativeSheet ? 44 : 36,
                      backgroundColor: isHighlighted
                        ? theme.colors.focusFill
                        : isHovered
                          ? theme.colors.actionGlassHoverBg
                          : !isTv && !isWeb && pressed
                            ? theme.colors.subtleHighlight
                            : isSelected
                              ? theme.colors.accentTint
                              : 'transparent',
                      ...(isTv
                        ? {
                            borderWidth: isHighlighted ? theme.focus.ringWidth : 1,
                            borderColor: isHighlighted
                              ? theme.colors.focusRingColor
                              : 'transparent',
                          }
                        : {}),
                      ...(!isTv && isWeb ? { opacity: pressed ? 0.85 : 1 } : {}),
                    },
                  ]}
                >
                  <Text
                    numberOfLines={1}
                    style={[
                      isTv
                        ? theme.typography.title
                        : isNativeSheet
                          ? theme.typography.body
                          : theme.typography.caption,
                      tabularNums ? TABULAR_NUMS_STYLE : undefined,
                      styles.menuOptionLabel,
                      {
                        color:
                          isHighlighted || isSelected
                            ? theme.colors.textPrimary
                            : theme.colors.textSecondary,
                        fontWeight: isSelected || isHighlighted ? '600' : '500',
                      },
                    ]}
                  >
                    {opt.label}
                  </Text>
                  {isSelected ? (
                    <Icon
                      testID={`${testID}-check-${idx}`}
                      name="check"
                      size={isTv ? 16 : 14}
                      color={theme.colors.accent}
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </View>
    );
  }, [
    cursor,
    dismissLabel,
    handleChoose,
    hasPortal,
    hoveredIdx,
    isOpen,
    isTv,
    isWeb,
    menuBlur,
    options,
    selectHint,
    selectedValue,
    setOpen,
    tabularNums,
    testID,
    theme,
    title,
    transition,
    tvHighlightedIndex,
    webPlacement,
  ]);

  useEffect(() => {
    if (portal === null) return;
    portal.setOverlay(overlayId, overlayNode);
  }, [overlayId, overlayNode, portal]);

  useEffect(() => {
    if (portal === null) return undefined;
    return () => {
      portal.setOverlay(overlayId, null);
    };
  }, [overlayId, portal]);

  return (
    <View
      testID={`${testID}-row`}
      onLayout={onLayoutY ? (e) => onLayoutY(e.nativeEvent.layout.y) : undefined}
      style={[styles.rowHeader, { zIndex: isOpen ? 80 : 1 }]}
    >
      <View style={styles.rowText}>
        <Text
          style={[
            theme.typography.title,
            tabularNums ? TABULAR_NUMS_STYLE : undefined,
            { color: theme.colors.textPrimary },
          ]}
        >
          {title}
        </Text>
        {description ? (
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {description}
          </Text>
        ) : null}
      </View>

      <View style={[styles.controlsGroup, { gap: theme.spacing.xs }]}>
        <View ref={containerRef} style={[styles.dropdownWrap, { zIndex: isOpen ? 80 : 2 }]}>
          {isTv && isOpen ? (
            <TvDropdownKeyTrap
              count={options.length}
              highlightedIndexRef={tvHighlightedIndexRef}
              onMove={handleMoveTvHighlight}
              onConfirm={handleConfirmTv}
              onClose={() => setOpen(false)}
            />
          ) : null}

          <Tooltip content={selectHint} disabled={isTv || isOpen || disabled}>
            <Pressable
              testID={testID}
              accessibilityRole="button"
              accessibilityLabel={`${title}: ${displayLabel}`}
              accessibilityState={{ expanded: isOpen, disabled }}
              disabled={disabled}
              focusable={!isTv}
              onPress={() => {
                if (!disabled) setOpen(!isOpen);
              }}
              style={({ pressed }) => [
                styles.triggerBtn,
                blur,
                cursor,
                transition,
                disabled ? styles.disabledTrigger : undefined,
                {
                  borderRadius: theme.radius.button,
                  backgroundColor:
                    triggerFocused || isOpen ? theme.colors.focusFill : theme.colors.actionGlassBg,
                  borderColor: isOpen ? theme.colors.accent : theme.colors.actionGlassBorder,
                  opacity: pressed ? 0.85 : 1,
                  transform: [
                    {
                      scale: pressed
                        ? theme.reduceMotion
                          ? 1
                          : 0.98
                        : triggerFocused
                          ? theme.focus.buttonScale
                          : 1,
                    },
                  ],
                },
              ]}
            >
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.caption,
                  tabularNums ? TABULAR_NUMS_STYLE : undefined,
                  styles.triggerLabel,
                  { color: theme.colors.textPrimary },
                ]}
              >
                {displayLabel}
              </Text>
              <Icon name="chevronDown" size={14} color={theme.colors.textSecondary} />
              {triggerFocused ? (
                <View
                  pointerEvents="none"
                  testID={`${testID}-focus-ring`}
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
            </Pressable>
          </Tooltip>

          {!hasPortal ? overlayNode : null}
        </View>

        {accessory ?? null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rowHeader: {
    position: 'relative',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  rowText: { flex: 1, minWidth: 200, gap: 2 },
  controlsGroup: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  dropdownWrap: { position: 'relative' },
  inlineAnchor: { position: 'relative' },
  sheetOverlayRoot: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    zIndex: 100,
  },
  dismissBackdropInline: {
    position: 'absolute',
    top: -1200,
    bottom: -1200,
    left: -1200,
    right: -1200,
    zIndex: 1,
  },
  triggerBtn: {
    position: 'relative',
    zIndex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    minWidth: 140,
    minHeight: 38,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
  },
  disabledTrigger: { opacity: 0.48 },
  triggerLabel: { fontWeight: '600', flexShrink: 1 },
  focusRing: { position: 'absolute', top: -3, bottom: -3, left: -3, right: -3 },
  menuPopoverPortal: {
    position: 'absolute',
    minWidth: 200,
    maxWidth: 320,
    padding: 4,
    borderWidth: 1,
    zIndex: 60,
  },
  menuPopoverPortalFallback: { top: 72, right: 24, maxHeight: 320 },
  menuPopoverInline: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 6,
    minWidth: 200,
    maxWidth: 320,
    maxHeight: 320,
    padding: 4,
    borderWidth: 1,
    zIndex: 60,
  },
  menuPopoverInlineUp: {
    position: 'absolute',
    bottom: '100%',
    right: 0,
    marginBottom: 6,
    minWidth: 200,
    maxWidth: 320,
    maxHeight: 320,
    padding: 4,
    borderWidth: 1,
    zIndex: 60,
  },
  nativeSheetPortal: { width: '100%', maxWidth: 360, maxHeight: 420, borderWidth: 1, zIndex: 80 },
  menuOptionsScroll: { maxHeight: 300 },
  menuOptionsList: { gap: 2 },
  menuOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  menuOptionLabel: { flex: 1 },
  tvBackdropInline: {
    position: 'absolute',
    top: -2000,
    bottom: -2000,
    left: -2000,
    right: -2000,
    zIndex: 70,
  },
  tvSheetPortal: { width: '100%', maxWidth: 380, maxHeight: 440, borderWidth: 1, zIndex: 80 },
  tvSheetInline: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 8,
    width: 340,
    maxHeight: 420,
    borderWidth: 1,
    zIndex: 80,
  },
  sheetHeader: { borderBottomWidth: StyleSheet.hairlineWidth, gap: 4 },
  sheetOptionsScroll: { maxHeight: 360 },
  tvOptionsList: { gap: 6, paddingVertical: 4 },
  tvOptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
});
