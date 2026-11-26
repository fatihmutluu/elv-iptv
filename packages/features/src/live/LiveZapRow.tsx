import type { ItemRow, ProgrammeRow } from '@elv/data';
import type { LogoBackdropModePref } from '@elv/domain';
import {
  ArtworkImage,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
  type Theme,
  Tooltip,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback, useRef } from 'react';
import {
  type AccessibilityActionEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { LiveHealthBadge } from './LiveHealthBadge';
import { formatLiveTitle } from './live-model';
import { SourceBadgePill } from './SourceBadgePill';
import { formatChannelDisplayName, type SourceBadgeInfo } from './source-badge';

function zapRowStyle(
  theme: Theme,
  rowHeight: number,
  isTouch: boolean,
  isActive: boolean,
  focused: boolean,
  pressed: boolean,
  isDragging: boolean,
): ViewStyle {
  return {
    height: rowHeight,
    minHeight: isTouch ? 44 : 40,
    backgroundColor: isDragging
      ? theme.colors.subtleHighlight
      : isActive
        ? theme.colors.accentTint
        : focused
          ? theme.colors.focusFill
          : 'transparent',
    borderLeftWidth: isActive ? 3 : 0,
    borderLeftColor: isActive ? theme.colors.accent : 'transparent',
    borderWidth: focused ? theme.focus.ringWidth : 0,
    borderColor: focused ? theme.colors.focusRingColor : 'transparent',
    opacity: isDragging ? 0.55 : pressed ? 0.84 : 1,
  };
}

function GripDots({ color }: { readonly color: string }): ReactElement {
  return (
    <View style={styles.gripGrid} pointerEvents="none">
      <View style={styles.gripRow}>
        <View style={[styles.gripDot, { backgroundColor: color }]} />
        <View style={[styles.gripDot, { backgroundColor: color }]} />
      </View>
      <View style={styles.gripRow}>
        <View style={[styles.gripDot, { backgroundColor: color }]} />
        <View style={[styles.gripDot, { backgroundColor: color }]} />
      </View>
      <View style={styles.gripRow}>
        <View style={[styles.gripDot, { backgroundColor: color }]} />
        <View style={[styles.gripDot, { backgroundColor: color }]} />
      </View>
    </View>
  );
}

/** Single row inside {@link LiveZapDrawer} showing channel logo, number, name, and active programme. */
export const ZapChannelRow = memo(function ZapChannelRowInner(p: {
  readonly index: number;
  readonly item: ItemRow | undefined;
  readonly nowTitle: string | null;
  readonly nowProgramme?: ProgrammeRow | null;
  readonly noProgramLabel: string;
  readonly rowHeight: number;
  readonly isActive: boolean;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly focused: boolean;
  readonly logoBackdropMode?: LogoBackdropModePref;
  readonly sourceBadge?: SourceBadgeInfo | null;
  readonly cleanChannelTitles?: boolean;
  readonly reorderable?: boolean;
  readonly isDragging?: boolean;
  readonly dropIndicator?: 'above' | 'below' | null;
  readonly totalCount?: number;
  readonly onStartDrag?: (index: number, clientY: number) => void;
  readonly onMoveUp?: (index: number) => void;
  readonly onMoveDown?: (index: number) => void;
  readonly onSelectChannel: (channel: ItemRow, index: number) => void;
  readonly onOpenContextMenu?: (
    channel: ItemRow,
    index: number,
    programme: ProgrammeRow | null,
  ) => void;
}): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');
  const gripInteractedRef = useRef(false);
  const handlePress = useCallback(() => {
    if (gripInteractedRef.current) {
      gripInteractedRef.current = false;
      return;
    }
    if (p.item) p.onSelectChannel(p.item, p.index);
  }, [p.index, p.item, p.onSelectChannel]);
  const handleLongPress = useCallback(() => {
    if (p.item) p.onOpenContextMenu?.(p.item, p.index, p.nowProgramme ?? null);
  }, [p.index, p.item, p.nowProgramme, p.onOpenContextMenu]);
  const isWeb = (Platform.OS as string) === 'web';
  const reorderable = p.reorderable === true;
  const isDragging = p.isDragging === true;
  const canMoveUp = reorderable && p.index > 0;
  const canMoveDown = reorderable && p.totalCount !== undefined && p.index < p.totalCount - 1;

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'moveUp' && canMoveUp) {
        p.onMoveUp?.(p.index);
      } else if (event.nativeEvent.actionName === 'moveDown' && canMoveDown) {
        p.onMoveDown?.(p.index);
      }
    },
    [canMoveDown, canMoveUp, p.index, p.onMoveDown, p.onMoveUp],
  );

  const webEventProps: Record<string, unknown> = {};
  if (isWeb && reorderable) {
    webEventProps.onPointerDown = () => {
      gripInteractedRef.current = false;
    };
  }
  if (isWeb && p.item !== undefined && p.onOpenContextMenu !== undefined) {
    webEventProps.onContextMenu = (e?: { preventDefault?: () => void }) => {
      e?.preventDefault?.();
      if (p.item) p.onOpenContextMenu?.(p.item, p.index, p.nowProgramme ?? null);
    };
  }
  if (isWeb && reorderable) {
    webEventProps.onKeyDown = (e?: {
      altKey?: boolean;
      key?: string;
      preventDefault?: () => void;
    }) => {
      if (e?.key === 'Enter' || e?.key === ' ') {
        gripInteractedRef.current = false;
      }
      if (!e?.altKey) return;
      if (e.key === 'ArrowUp' && canMoveUp) {
        e.preventDefault?.();
        p.onMoveUp?.(p.index);
      } else if (e.key === 'ArrowDown' && canMoveDown) {
        e.preventDefault?.();
        p.onMoveDown?.(p.index);
      }
    };
  }

  const gripPointerProps =
    isWeb && reorderable && p.onStartDrag !== undefined
      ? ({
          onPointerDown: (e?: {
            clientY?: number;
            stopPropagation?: () => void;
            preventDefault?: () => void;
          }) => {
            gripInteractedRef.current = true;
            e?.stopPropagation?.();
            e?.preventDefault?.();
            p.onStartDrag?.(p.index, e?.clientY ?? 0);
          },
          onClick: (e?: { stopPropagation?: () => void; preventDefault?: () => void }) => {
            e?.stopPropagation?.();
            e?.preventDefault?.();
          },
        } as Record<string, unknown>)
      : undefined;

  if (!p.item) {
    return (
      <View style={[styles.zapRow, { height: p.rowHeight }]}>
        <SkeletonBox width={34} height={34} borderRadius={theme.radius.button} />
        <View style={styles.zapRowText}>
          <SkeletonBox width="70%" height={12} borderRadius={theme.radius.button} />
          <SkeletonBox width="50%" height={10} borderRadius={theme.radius.button} />
        </View>
      </View>
    );
  }

  const displayName = formatChannelDisplayName(p.item.name, p.cleanChannelTitles ?? false);
  const accessibilityActions = reorderable
    ? [
        ...(canMoveUp ? [{ name: 'moveUp', label: i18n.t('live.moveFavoriteUp') }] : []),
        ...(canMoveDown ? [{ name: 'moveDown', label: i18n.t('live.moveFavoriteDown') }] : []),
      ]
    : undefined;

  return (
    <View style={styles.rowWrap}>
      {p.dropIndicator === 'above' ? (
        <View
          testID={`live-zap-drop-above-${p.index}`}
          pointerEvents="none"
          style={[styles.dropLine, styles.dropLineTop, { backgroundColor: theme.colors.accent }]}
        />
      ) : null}
      <Pressable
        testID={`live-zap-row-${p.index}`}
        accessibilityRole="button"
        accessibilityLabel={formatLiveTitle({ num: p.item.num, name: displayName })}
        accessibilityState={{ selected: p.isActive }}
        {...(accessibilityActions !== undefined && accessibilityActions.length > 0
          ? { accessibilityActions, onAccessibilityAction: handleAccessibilityAction }
          : {})}
        focusable={!p.isTv}
        onPress={handlePress}
        {...(p.onOpenContextMenu !== undefined
          ? { onLongPress: handleLongPress, delayLongPress: 450 }
          : {})}
        {...webEventProps}
        style={({ pressed }) => [
          styles.zapRow,
          zapRowStyle(theme, p.rowHeight, p.isTouch, p.isActive, p.focused, pressed, isDragging),
          cursor,
          transition,
        ]}
      >
        {isWeb && reorderable ? (
          <Tooltip content={i18n.t('live.reorderHint')} placement="right">
            <View
              testID={`live-zap-drag-handle-${p.index}`}
              accessibilityLabel={i18n.t('live.reorderHint')}
              style={[
                styles.gripHandle,
                { cursor: isDragging ? 'grabbing' : 'grab' } as unknown as ViewStyle,
              ]}
              {...gripPointerProps}
            >
              <GripDots color={theme.colors.textMuted} />
            </View>
          </Tooltip>
        ) : null}
        <ArtworkImage
          uri={p.item.logo}
          label={displayName}
          maxDecodePx={96}
          resizeMode="contain"
          logoBackdropMode={p.logoBackdropMode ?? 'plate'}
          borderRadius={theme.radius.button}
          style={styles.zapLogo}
        />
        <View style={styles.zapRowText}>
          <View style={styles.zapTitleRow}>
            {p.item.num !== null && p.item.num !== undefined ? (
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.caption,
                  TABULAR_NUMS_STYLE,
                  {
                    color: p.isActive ? theme.colors.textPrimary : theme.colors.textMuted,
                    fontWeight: '700',
                  },
                ]}
              >
                {p.item.num}
              </Text>
            ) : null}
            <Text
              numberOfLines={1}
              style={[theme.typography.title, styles.flex1, { color: theme.colors.textPrimary }]}
            >
              {displayName}
            </Text>
            <SourceBadgePill badge={p.sourceBadge} testID={`live-zap-source-badge-${p.index}`} />
            <LiveHealthBadge channelKey={p.item.key} testID={`live-zap-health-${p.index}`} />
          </View>
          <Text
            numberOfLines={1}
            style={[
              theme.typography.caption,
              { color: p.nowTitle ? theme.colors.textSecondary : theme.colors.textMuted },
            ]}
          >
            {p.nowTitle ?? p.noProgramLabel}
          </Text>
        </View>
      </Pressable>
      {p.dropIndicator === 'below' ? (
        <View
          testID={`live-zap-drop-below-${p.index}`}
          pointerEvents="none"
          style={[styles.dropLine, styles.dropLineBottom, { backgroundColor: theme.colors.accent }]}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  rowWrap: { position: 'relative' },
  zapRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 10 },
  zapLogo: { width: 34, height: 34, flexShrink: 0 },
  zapRowText: { flex: 1, gap: 2 },
  zapTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  gripHandle: {
    width: 18,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    opacity: 0.72,
  },
  gripGrid: { gap: 3 },
  gripRow: { flexDirection: 'row', gap: 3 },
  gripDot: { width: 2.5, height: 2.5, borderRadius: 2 },
  dropLine: { position: 'absolute', left: 10, right: 10, height: 2, borderRadius: 1, zIndex: 4 },
  dropLineTop: { top: 0 },
  dropLineBottom: { bottom: 0 },
});
