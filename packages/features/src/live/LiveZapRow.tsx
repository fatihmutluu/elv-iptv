import type { ItemRow } from '@elv/data';
import {
  ArtworkImage,
  SkeletonBox,
  TABULAR_NUMS_STYLE,
  type Theme,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { formatLiveTitle } from './live-model';

function zapRowStyle(
  theme: Theme,
  rowHeight: number,
  isTouch: boolean,
  isActive: boolean,
  focused: boolean,
  pressed: boolean,
): ViewStyle {
  return {
    height: rowHeight,
    minHeight: isTouch ? 44 : 40,
    backgroundColor: isActive
      ? theme.colors.accentTint
      : focused
        ? theme.colors.focusFill
        : 'transparent',
    borderLeftWidth: isActive ? 3 : 0,
    borderLeftColor: isActive ? theme.colors.accent : 'transparent',
    borderWidth: focused ? theme.focus.ringWidth : 0,
    borderColor: focused ? theme.colors.focusRingColor : 'transparent',
    opacity: pressed ? 0.84 : 1,
  };
}

/** Single row inside {@link LiveZapDrawer} showing channel logo, number, name, and active programme. */
export const ZapChannelRow = memo(function ZapChannelRowInner(p: {
  readonly index: number;
  readonly item: ItemRow | undefined;
  readonly nowTitle: string | null;
  readonly noProgramLabel: string;
  readonly rowHeight: number;
  readonly isActive: boolean;
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly focused: boolean;
  readonly onSelectChannel: (channel: ItemRow, index: number) => void;
}): ReactElement {
  const theme = useTheme();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');
  const handlePress = useCallback(() => {
    if (p.item) p.onSelectChannel(p.item, p.index);
  }, [p.index, p.item, p.onSelectChannel]);

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

  return (
    <Pressable
      testID={`live-zap-row-${p.index}`}
      accessibilityRole="button"
      accessibilityLabel={formatLiveTitle(p.item)}
      accessibilityState={{ selected: p.isActive }}
      focusable={!p.isTv}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.zapRow,
        zapRowStyle(theme, p.rowHeight, p.isTouch, p.isActive, p.focused, pressed),
        cursor,
        transition,
      ]}
    >
      <ArtworkImage
        uri={p.item.logo}
        label={p.item.name}
        maxDecodePx={96}
        resizeMode="contain"
        logoBackdrop
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
            {p.item.name}
          </Text>
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
  );
});

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  zapRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 10 },
  zapLogo: { width: 34, height: 34, flexShrink: 0 },
  zapRowText: { flex: 1, gap: 2 },
  zapTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
