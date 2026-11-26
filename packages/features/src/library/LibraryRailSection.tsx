import {
  type ContextMenuAnchor,
  HorizontalRailScroll,
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

/** Props of {@link LibraryRailSection}. */
export interface LibraryRailSectionProps {
  readonly railId: string;
  readonly title: string;
  readonly items: readonly LibraryCardItem[];
  readonly variant: 'live' | 'poster';
  readonly cardWidth: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly focusedCardIndex?: number | null;
  readonly onPressItem: (item: LibraryCardItem) => void;
  readonly onContextMenuItem?: (item: LibraryCardItem, anchor?: ContextMenuAnchor) => void;
  readonly onSeeAll?: () => void;
}

/** One horizontal editorial rail inside {@link LibraryScreen} with a `See all ›` drill-down action. */
export function LibraryRailSection({
  railId,
  title,
  items,
  variant,
  cardWidth,
  padX,
  isTv,
  focusedCardIndex = null,
  onPressItem,
  onContextMenuItem,
  onSeeAll,
}: LibraryRailSectionProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'opacity, color');

  if (items.length === 0) return null;

  const cardGap = isTv ? 18 : 14;

  return (
    <View testID={`library-rail-${railId}`} style={styles.section}>
      <View style={[styles.headerRow, { paddingHorizontal: padX }]}>
        <Text
          numberOfLines={1}
          style={[theme.typography.h2, styles.title, { color: theme.colors.textPrimary }]}
        >
          {title}
        </Text>
        {onSeeAll !== undefined ? (
          <Pressable
            testID={`library-see-all-${railId}`}
            accessibilityRole="button"
            accessibilityLabel={`${i18n.t('library.seeAll')} — ${title}`}
            focusable={!isTv}
            onPress={onSeeAll}
            style={({ pressed }) => [
              styles.seeAllBtn,
              cursor,
              transition,
              { opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('library.seeAll')}
            </Text>
            <Icon name="chevronRight" size={14} color={theme.colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      <HorizontalRailScroll
        testID={`library-rail-scroll-${railId}`}
        isTv={isTv}
        contentContainerStyle={{
          paddingHorizontal: padX,
          gap: cardGap,
          paddingVertical: 4,
        }}
      >
        {items.map((item, idx) => {
          const isFocused = isTv && focusedCardIndex === idx;
          const handleContext = onContextMenuItem
            ? (anchor?: ContextMenuAnchor) => onContextMenuItem(item, anchor)
            : undefined;
          if (variant === 'live') {
            return (
              <WideCard
                key={item.id}
                testID={`library-card-${railId}-${item.id}`}
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
              testID={`library-card-${railId}-${item.id}`}
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
      </HorizontalRailScroll>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 10,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: {
    flexShrink: 1,
    minWidth: 0,
  },
  seeAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
});
