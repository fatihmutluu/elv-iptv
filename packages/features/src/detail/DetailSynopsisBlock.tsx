import {
  AdaptiveSheet,
  CtaButton,
  Icon,
  useI18n,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webShadow,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  memo,
  type ReactElement,
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
  type TextLayoutEvent,
  View,
  type ViewStyle,
} from 'react-native';
import { useDesktopDialogTrap } from '../shared/desktop-dialog-trap';
import { attachWebOutsideDismiss } from './DetailHeroExtras';
import {
  computeSynopsisCharBudget,
  SYNOPSIS_INLINE_MAX_LINES,
  truncateSynopsisForInline,
} from './detail-preplay';

/** Props of {@link DetailSynopsisBlock}. */
export interface DetailSynopsisBlockProps {
  readonly title: string;
  readonly synopsis: string;
  readonly canExpand: boolean;
  readonly expanded: boolean;
  readonly isTv: boolean;
  readonly isPortrait?: boolean;
  readonly focused: boolean;
  readonly onToggle?: () => void;
  readonly onDismiss?: () => void;
}

const POPOVER_NATIVE_SHADOW: ViewStyle = {
  shadowColor: 'rgba(0, 0, 0, 1)',
  shadowOffset: { width: 0, height: 18 },
  shadowOpacity: 0.65,
  shadowRadius: 32,
  elevation: 20,
};

/**
 * Detail Hero inline synopsis (`Wave R2`).
 * Renders short plots completely with zero trigger; when genuinely overflowing the 3-line budget
 * (or detected via `onTextLayout`), clamps at a word boundary ending inline with underlined
 * `"see more..."` opening a floating frosted popover directly above the synopsis on
 * Desktop/Landscape or `DetailSynopsisSheet` on TV/Portrait.
 */
export const DetailSynopsisBlock = memo(function DetailSynopsisBlockInner({
  title,
  synopsis,
  canExpand,
  expanded,
  isTv,
  isPortrait = false,
  focused,
  onToggle,
  onDismiss,
}: DetailSynopsisBlockProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const cursor = webCursorPointer();
  const popoverBlur = webBackdropBlur(20);
  const containerRef = useRef<ComponentRef<typeof View>>(null);
  const dialogRef = useRef<ComponentRef<typeof View>>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const [measuredLineBudget, setMeasuredLineBudget] = useState<number | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: clear measured line clamp when synopsis changes
  useEffect(() => {
    setMeasuredLineBudget(null);
  }, [synopsis]);

  const charBudget = computeSynopsisCharBudget(measuredWidth, theme.fontScale, isPortrait);
  const effectiveBudget =
    measuredLineBudget !== null ? Math.min(charBudget, measuredLineBudget) : charBudget;
  const inline = truncateSynopsisForInline(synopsis, effectiveBudget);
  const showInlineTrigger = inline.truncated && canExpand && onToggle !== undefined;

  const useAnchoredPopover = !isTv && !isPortrait;
  const popoverOpen = expanded && showInlineTrigger && useAnchoredPopover;
  const handleDismiss = useCallback(() => {
    if (onDismiss) onDismiss();
    else if (expanded) onToggle?.();
  }, [expanded, onDismiss, onToggle]);

  useDesktopDialogTrap(dialogRef, popoverOpen && (Platform.OS as string) === 'web', handleDismiss);

  useEffect(
    () => attachWebOutsideDismiss(popoverOpen, containerRef, handleDismiss, dialogRef),
    [handleDismiss, popoverOpen],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    if (nextWidth > 0) {
      setMeasuredWidth((prev) => (Math.abs(nextWidth - prev) > 8 ? nextWidth : prev));
    }
  }, []);

  const handleTextLayout = useCallback(
    (event: TextLayoutEvent) => {
      if (inline.truncated) return;
      const lines = event.nativeEvent.lines;
      if (lines.length <= SYNOPSIS_INLINE_MAX_LINES) return;
      const firstThreeChars = lines
        .slice(0, SYNOPSIS_INLINE_MAX_LINES)
        .reduce((sum, line) => sum + line.text.length, 0);
      if (firstThreeChars > 0) {
        setMeasuredLineBudget(Math.max(60, firstThreeChars));
      }
    },
    [inline.truncated],
  );

  const seeMoreLabel = i18n.t('detail.seeMoreInline');
  const synopsisFontSize = Math.round(15 * theme.fontScale * 2) / 2;
  const synopsisLineHeight = Math.round(22 * theme.fontScale);
  const bodyFontFamily =
    theme.typography.body.fontFamily !== undefined
      ? { fontFamily: theme.typography.body.fontFamily }
      : undefined;

  const synopsisTextStyle = [
    bodyFontFamily,
    styles.synopsis,
    {
      color: theme.colors.textPrimary,
      fontSize: synopsisFontSize,
      lineHeight: synopsisLineHeight,
    },
  ];

  const isWeb = (Platform.OS as string) === 'web';
  const webBackdropProps = isWeb ? ({ tabIndex: -1, 'aria-hidden': true } as object) : {};
  const webToggleProps =
    isWeb && !isTv
      ? ({
          tabIndex: 0,
          onKeyDown: (ev: {
            key?: unknown;
            preventDefault?: () => void;
            stopPropagation?: () => void;
          }) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault?.();
              ev.stopPropagation?.();
              onToggle?.();
            }
          },
        } as object)
      : {};

  return (
    <View
      ref={containerRef}
      onLayout={handleLayout}
      style={[styles.synopsisWrap, { zIndex: popoverOpen ? 45 : 2 }]}
    >
      {popoverOpen ? (
        <View
          ref={dialogRef}
          testID="detail-synopsis-popover-dialog"
          accessibilityViewIsModal
          style={styles.popoverTrapHost}
        >
          <Pressable
            testID="detail-synopsis-popover-backdrop"
            accessible={false}
            focusable={false}
            {...webBackdropProps}
            onPress={handleDismiss}
            style={
              isWeb
                ? ({
                    position: 'fixed',
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: 0,
                    zIndex: 1,
                  } as unknown as ViewStyle)
                : styles.dismissBackdrop
            }
          />
          <View
            testID="detail-synopsis-popover"
            style={[
              styles.popoverPanel,
              popoverBlur,
              POPOVER_NATIVE_SHADOW,
              webShadow('0 24px 64px rgba(0, 0, 0, 0.85)'),
              {
                borderRadius: theme.radius.modal,
                backgroundColor: theme.colors.glassBg,
                borderColor: theme.colors.glassBorder,
                padding: theme.spacing.md,
              },
            ]}
          >
            <View
              style={[
                styles.popoverHeader,
                {
                  borderBottomColor: theme.colors.surfaceBorder,
                  paddingBottom: theme.spacing.xs,
                  marginBottom: theme.spacing.sm,
                },
              ]}
            >
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.title,
                  styles.popoverTitle,
                  { color: theme.colors.textPrimary },
                ]}
              >
                {title || i18n.t('detail.synopsisTitle')}
              </Text>
              <Pressable
                testID="detail-synopsis-popover-close"
                accessibilityRole="button"
                accessibilityLabel={i18n.t('ui.dismiss')}
                onPress={handleDismiss}
                style={({ pressed }) => [
                  styles.popoverCloseBtn,
                  cursor,
                  {
                    borderRadius: theme.radius.pill,
                    backgroundColor: theme.colors.actionGlassBg,
                    opacity: pressed ? 0.75 : 1,
                  },
                ]}
              >
                <Icon name="close" size={16} color={theme.colors.textPrimary} />
              </Pressable>
            </View>
            <ScrollView style={styles.popoverScroll} showsVerticalScrollIndicator>
              <Text
                testID="detail-synopsis-full"
                style={[
                  bodyFontFamily,
                  {
                    color: theme.colors.textPrimary,
                    fontSize: synopsisFontSize,
                    lineHeight: synopsisLineHeight,
                  },
                ]}
              >
                {synopsis}
              </Text>
            </ScrollView>
          </View>
        </View>
      ) : null}

      <Text testID="detail-synopsis" onTextLayout={handleTextLayout} style={synopsisTextStyle}>
        {showInlineTrigger ? (
          <>
            {`${inline.text} `}
            <Text
              testID="detail-synopsis-toggle"
              accessibilityRole="button"
              accessibilityLabel={seeMoreLabel}
              accessibilityState={{ expanded }}
              {...webToggleProps}
              onPress={onToggle}
              style={[
                cursor,
                styles.inlineToggle,
                {
                  color: theme.colors.textPrimary,
                  backgroundColor: isTv && focused ? theme.colors.focusFill : 'transparent',
                },
              ]}
            >
              {seeMoreLabel}
            </Text>
          </>
        ) : (
          synopsis
        )}
      </Text>

      {isTv && focused && showInlineTrigger ? (
        <View
          pointerEvents="none"
          testID="detail-synopsis-toggle-focus-ring"
          style={[
            styles.synopsisFocusRing,
            {
              borderRadius: theme.radius.button,
              borderWidth: theme.focus.ringWidth,
              borderColor: theme.colors.focusRingColor,
            },
          ]}
        />
      ) : null}
    </View>
  );
});

/** Props of {@link DetailSynopsisSheet}. */
export interface DetailSynopsisSheetProps {
  readonly visible: boolean;
  readonly title: string;
  readonly synopsis: string;
  readonly isTv: boolean;
  readonly onDismiss: () => void;
}

/**
 * TV- and Portrait-safe accessible `AdaptiveSheet` modal reader for long Detail synopses (`#398`).
 * Keeps full untruncated plot text scrollable without clipping on 10-ft TVs or narrow phones.
 */
export const DetailSynopsisSheet = memo(function DetailSynopsisSheetInner({
  visible,
  title,
  synopsis,
  isTv,
  onDismiss,
}: DetailSynopsisSheetProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  return (
    <AdaptiveSheet
      visible={visible}
      testID="detail-synopsis-sheet"
      title={i18n.t('detail.synopsisTitle')}
      popoverWidth={440}
      onDismiss={onDismiss}
    >
      <Text
        numberOfLines={2}
        style={[theme.typography.h2, { color: theme.colors.textPrimary, marginBottom: 8 }]}
      >
        {title}
      </Text>
      <ScrollView style={styles.synopsisScroll} showsVerticalScrollIndicator>
        <Text
          testID="detail-synopsis-full"
          style={[theme.typography.body, { color: theme.colors.textSecondary }]}
        >
          {synopsis}
        </Text>
      </ScrollView>
      <View style={[styles.sheetFooter, { marginTop: theme.spacing.md }]}>
        <CtaButton
          testID="detail-synopsis-close"
          variant="secondary"
          label={i18n.t('detail.readLess')}
          focusable={!isTv}
          focused={isTv}
          onPress={onDismiss}
        />
      </View>
    </AdaptiveSheet>
  );
});

const styles = StyleSheet.create({
  dismissBackdrop: {
    position: 'absolute',
    top: -1200,
    bottom: -1200,
    left: -1200,
    right: -1200,
    zIndex: 1,
  },
  synopsisWrap: {
    position: 'relative',
    width: '100%',
    maxWidth: 660,
  },
  popoverTrapHost: {
    position: 'relative',
    width: '100%',
    height: 0,
    zIndex: 2,
  },
  synopsis: {
    maxWidth: 660,
  },
  inlineToggle: {
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  synopsisFocusRing: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    left: -6,
    right: -6,
  },
  popoverPanel: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    marginBottom: 10,
    width: '100%',
    maxWidth: 560,
    borderWidth: 1,
    zIndex: 5,
  },
  popoverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  popoverTitle: {
    flex: 1,
    fontWeight: '700',
  },
  popoverCloseBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  popoverScroll: {
    maxHeight: 240,
  },
  synopsisScroll: {
    maxHeight: 280,
  },
  sheetFooter: {
    alignItems: 'flex-end',
  },
});
