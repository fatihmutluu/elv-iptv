import {
  type ContextMenuAnchor,
  Icon,
  PosterCard,
  useI18n,
  useTheme,
  WideCard,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { LibraryCardItem } from './library-model';

/** Props of {@link LibrarySeeAllGrid}. */
export interface LibrarySeeAllGridProps {
  readonly railId: string;
  readonly title: string;
  readonly items: readonly LibraryCardItem[];
  readonly variant: 'live' | 'poster';
  readonly cardWidth: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly focusedIndex?: number | null;
  readonly onBack: () => void;
  readonly onPressItem: (item: LibraryCardItem) => void;
  readonly onContextMenuItem?: (item: LibraryCardItem, anchor?: ContextMenuAnchor) => void;
}

/** Full vertical grid drill-down opened from any rail's `See all ›` action. */
export function LibrarySeeAllGrid({
  railId,
  title,
  items,
  variant,
  cardWidth,
  padX,
  isTv,
  focusedIndex = null,
  onBack,
  onPressItem,
  onContextMenuItem,
}: LibrarySeeAllGridProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'opacity, background-color');

  return (
    <View
      testID={`library-see-all-grid-${railId}`}
      style={[styles.root, { paddingHorizontal: padX }]}
    >
      <View style={styles.headerRow}>
        <Pressable
          testID="library-see-all-back"
          accessibilityRole="button"
          accessibilityLabel={i18n.t('library.backToTab')}
          focusable={!isTv}
          onPress={onBack}
          style={({ pressed }) => [
            styles.backBtn,
            cursor,
            transition,
            {
              borderRadius: theme.radius.pill,
              backgroundColor: pressed ? theme.colors.actionGlassHoverBg : theme.colors.bgCard,
              borderColor: theme.colors.surfaceBorder,
            },
          ]}
        >
          <Icon name="chevronLeft" size={16} color={theme.colors.textPrimary} />
          <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
            {i18n.t('library.backToTab')}
          </Text>
        </Pressable>
        <Text
          numberOfLines={1}
          style={[theme.typography.h2, styles.title, { color: theme.colors.textPrimary }]}
        >
          {title}
        </Text>
      </View>

      <View style={[styles.grid, { gap: isTv ? 18 : 14 }]}>
        {items.map((item, idx) => {
          const isFocused = isTv && focusedIndex === idx;
          const handleContext = onContextMenuItem
            ? (anchor?: ContextMenuAnchor) => onContextMenuItem(item, anchor)
            : undefined;
          if (variant === 'live') {
            return (
              <WideCard
                key={item.id}
                testID={`library-grid-card-${item.id}`}
                title={item.title}
                imageUri={item.imageUri}
                live
                logoBackdrop
                width={cardWidth}
                focusable={!isTv}
                focused={isFocused}
                onPress={() => onPressItem(item)}
                {...(handleContext !== undefined ? { onContextMenu: handleContext } : {})}
              />
            );
          }
          return (
            <PosterCard
              key={item.id}
              testID={`library-grid-card-${item.id}`}
              title={item.title}
              imageUri={item.imageUri}
              width={cardWidth}
              focusable={!isTv}
              focused={isFocused}
              {...(item.subtitle !== undefined ? { meta: item.subtitle } : {})}
              {...(item.badge !== undefined ? { badge: item.badge } : {})}
              {...(item.allWatched === true ? { allWatched: true } : {})}
              onPress={() => onPressItem(item)}
              {...(handleContext !== undefined ? { onContextMenu: handleContext } : {})}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
  },
  title: {
    flexShrink: 1,
    minWidth: 0,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
  },
});
