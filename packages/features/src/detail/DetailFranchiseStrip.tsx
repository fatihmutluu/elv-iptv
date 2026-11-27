import type { ElvFranchiseLibraryItem, ItemRow } from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES, type ElvModePreferences } from '@elv/domain';
import { HorizontalRailScroll, PosterCard, useI18n, useTheme } from '@elv/ui-kit';
import {
  type ComponentRef,
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { type LayoutChangeEvent, type ScrollView, StyleSheet, Text, View } from 'react-native';
import { applyElvCardPresentation, formatVodMeta } from '../shared';

/** Props of {@link DetailFranchiseStrip}. */
export interface DetailFranchiseStripProps {
  readonly items: readonly ElvFranchiseLibraryItem[];
  readonly currentItemKey: string;
  readonly elvPreferences?: ElvModePreferences;
  readonly cardWidth: number;
  readonly gap: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly focusedIndex: number | null;
  readonly onPressItem: (item: ItemRow) => void;
  readonly onLayoutY?: (y: number) => void;
}

/**
 * Chronological Cinema Quietude library rail (`#512`) displaying other movies/series belonging to
 * the same IMDb franchise in the user's active IPTV library (shown only when `>= 2` items exist).
 */
export const DetailFranchiseStrip = memo(function DetailFranchiseStripInner({
  items,
  currentItemKey,
  elvPreferences,
  cardWidth,
  gap,
  padX,
  isTv,
  focusedIndex,
  onPressItem,
  onLayoutY,
}: DetailFranchiseStripProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  useEffect(() => {
    if (!isTv || focusedIndex === null || focusedIndex < 0) return;
    const x = Math.max(0, focusedIndex * (cardWidth + gap) - padX);
    scrollRef.current?.scrollTo({ x, animated: !theme.reduceMotion });
  }, [cardWidth, focusedIndex, gap, isTv, padX, theme.reduceMotion]);

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      onLayoutY?.(e.nativeEvent.layout.y);
    },
    [onLayoutY],
  );

  const effectivePrefs = elvPreferences ?? DEFAULT_ELV_MODE_PREFERENCES;

  const presentedItems = useMemo(
    () =>
      items.map((entry) => ({
        entry,
        item: applyElvCardPresentation(entry.item, entry.enrichment, effectivePrefs, i18n.locale),
      })),
    [effectivePrefs, i18n.locale, items],
  );

  if (presentedItems.length < 2) return null;

  return (
    <View
      testID="detail-franchise-strip"
      onLayout={onLayoutY ? handleLayout : undefined}
      style={[styles.section, { marginTop: theme.spacing.lg }]}
    >
      <Text
        testID="detail-franchise-title"
        numberOfLines={1}
        style={[
          theme.typography.h2,
          { color: theme.colors.textPrimary, paddingHorizontal: padX, marginBottom: 4 },
        ]}
      >
        {i18n.t('detail.franchise.title')}
      </Text>

      <HorizontalRailScroll
        scrollRef={scrollRef}
        testID="detail-franchise-rail-scroll"
        isTv={isTv}
        showArrows={!isTv}
        contentContainerStyle={[
          styles.stripContent,
          {
            paddingHorizontal: padX,
            paddingTop: isTv ? 18 : 8,
            paddingBottom: isTv ? 20 : 12,
            gap,
          },
        ]}
      >
        {presentedItems.map(({ entry, item }, index) => {
          const isCurrent = item.key === currentItemKey;
          const meta = formatVodMeta(item.year, item.rating);
          const badge = isCurrent
            ? i18n.t('detail.franchise.current')
            : entry.franchiseOrder !== null && Number.isFinite(entry.franchiseOrder)
              ? `#${entry.franchiseOrder}`
              : undefined;

          return (
            <View
              key={item.key}
              style={
                isCurrent
                  ? [
                      styles.currentHighlight,
                      {
                        borderColor: theme.colors.accent,
                        borderRadius: theme.radius.card + 2,
                      },
                    ]
                  : undefined
              }
            >
              <PosterCard
                testID={`detail-franchise-item-${index}`}
                title={item.name}
                {...(meta !== undefined ? { meta } : {})}
                imageUri={item.logo}
                {...(badge !== undefined ? { badge } : {})}
                width={cardWidth}
                maxDecodePx={320}
                focusable={!isTv}
                focused={isTv && focusedIndex === index}
                onPress={() => {
                  if (!isCurrent) onPressItem(item);
                }}
              />
            </View>
          );
        })}
      </HorizontalRailScroll>
    </View>
  );
});

DetailFranchiseStrip.displayName = 'DetailFranchiseStrip';

const styles = StyleSheet.create({
  section: {
    width: '100%',
  },
  stripContent: {
    alignItems: 'flex-start',
  },
  currentHighlight: {
    borderWidth: 1.5,
    padding: 2,
  },
});
