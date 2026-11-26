import type { WatchProgressRow } from '@elv/data';
import {
  type ContextMenuAnchor,
  HorizontalRailScroll,
  useContextMenu,
  useI18n,
  useTheme,
  WideCard,
} from '@elv/ui-kit';
import { type ComponentRef, memo, type ReactElement, useCallback, useEffect, useRef } from 'react';
import { type LayoutChangeEvent, type ScrollView, StyleSheet, Text, View } from 'react-native';
import type { DetailTarget } from '../shared';
import { buildContinueWatchingContextMenuItems } from './catalog-context-menu';
import {
  computeProgressRatio,
  detailTargetFromProgress,
  formatCatalogRemainingMinutes,
} from './catalog-model';

/** Props of {@link CatalogContinueWatchingRail}. */
export interface CatalogContinueWatchingRailProps {
  readonly kind: 'movie' | 'series';
  readonly items: readonly WatchProgressRow[];
  readonly cardWidth: number;
  readonly gap: number;
  readonly padX: number;
  readonly isTv: boolean;
  readonly focusedIndex: number | null;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onResumeContinue?: (row: WatchProgressRow) => void;
  readonly onHideContinue?: (row: WatchProgressRow) => void;
  readonly onMarkContinueWatched?: (row: WatchProgressRow) => void;
  readonly onLayoutY?: (y: number) => void;
}

interface ContinueCardItemProps {
  readonly kind: 'movie' | 'series';
  readonly row: WatchProgressRow;
  readonly cardWidth: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly testID: string;
  readonly formatRemMin: (minutes: number) => string;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onResumeContinue?: (row: WatchProgressRow) => void;
  readonly onHideContinue?: (row: WatchProgressRow) => void;
  readonly onMarkContinueWatched?: (row: WatchProgressRow) => void;
}

const ContinueCardItem = memo(function ContinueCardItemInner({
  kind,
  row,
  cardWidth,
  isTv,
  focused,
  testID,
  formatRemMin,
  onOpenDetail,
  onResumeContinue,
  onHideContinue,
  onMarkContinueWatched,
}: ContinueCardItemProps): ReactElement {
  const i18n = useI18n();
  const { openContextMenu } = useContextMenu();

  const handlePress = useCallback(() => {
    onOpenDetail(detailTargetFromProgress(row, kind));
  }, [kind, onOpenDetail, row]);

  const handleContextMenu = useCallback(
    (anchor?: ContextMenuAnchor) => {
      openContextMenu({
        title: row.title,
        ...(row.subtitle ? { subtitle: row.subtitle } : {}),
        ...(anchor !== undefined ? { anchor } : {}),
        items: buildContinueWatchingContextMenuItems({
          kind,
          row,
          i18n,
          onOpenDetail,
          ...(onResumeContinue !== undefined ? { onResume: onResumeContinue } : {}),
          ...(onHideContinue !== undefined ? { onHideContinue } : {}),
          ...(onMarkContinueWatched !== undefined ? { onMarkWatched: onMarkContinueWatched } : {}),
        }),
      });
    },
    [
      i18n,
      kind,
      onHideContinue,
      onMarkContinueWatched,
      onOpenDetail,
      onResumeContinue,
      openContextMenu,
      row,
    ],
  );

  const ratio = computeProgressRatio(row);
  const remMin = formatCatalogRemainingMinutes(row.positionMs, row.durationMs);
  const remLabel = remMin !== null ? formatRemMin(remMin) : undefined;
  const subtitle =
    row.subtitle && remLabel
      ? `${row.subtitle} · ${remLabel}`
      : (remLabel ?? row.subtitle ?? undefined);

  return (
    <WideCard
      testID={testID}
      title={row.title}
      {...(subtitle !== undefined ? { subtitle } : {})}
      imageUri={row.logo}
      showPlayBadge
      {...(ratio !== undefined ? { progress: ratio } : {})}
      width={cardWidth}
      maxDecodePx={480}
      focusable={!isTv}
      focused={focused}
      onPress={handlePress}
      onContextMenu={handleContextMenu}
    />
  );
});

function CatalogContinueWatchingRailInner({
  kind,
  items,
  cardWidth,
  gap,
  padX,
  isTv,
  focusedIndex,
  onOpenDetail,
  onResumeContinue,
  onHideContinue,
  onMarkContinueWatched,
  onLayoutY,
}: CatalogContinueWatchingRailProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  useEffect(() => {
    if (!isTv || focusedIndex === null || focusedIndex < 0 || focusedIndex >= items.length) return;
    const x = Math.max(0, focusedIndex * (cardWidth + gap) - padX);
    scrollRef.current?.scrollTo({ x, animated: !theme.reduceMotion });
  }, [cardWidth, focusedIndex, gap, isTv, items.length, padX, theme.reduceMotion]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onLayoutY?.(event.nativeEvent.layout.y);
    },
    [onLayoutY],
  );

  const formatRemMin = useCallback(
    (minutes: number) => i18n.t('home.remainingMin', { minutes }),
    [i18n],
  );

  if (items.length === 0) return null;

  return (
    <View
      testID="catalog-continue-rail"
      onLayout={onLayoutY ? handleLayout : undefined}
      style={styles.section}
    >
      <View style={[styles.header, { paddingHorizontal: padX }]}>
        <Text
          numberOfLines={1}
          style={[theme.typography.h2, styles.title, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('catalog.continueWatching')}
        </Text>
      </View>

      <HorizontalRailScroll
        scrollRef={scrollRef}
        testID="catalog-continue-strip"
        isTv={isTv}
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
        {items.map((row, index) => (
          <ContinueCardItem
            key={row.itemKey}
            kind={kind}
            row={row}
            cardWidth={cardWidth}
            isTv={isTv}
            focused={isTv && focusedIndex === index}
            testID={`catalog-continue-item-${index}`}
            formatRemMin={formatRemMin}
            onOpenDetail={onOpenDetail}
            {...(onResumeContinue !== undefined ? { onResumeContinue } : {})}
            {...(onHideContinue !== undefined ? { onHideContinue } : {})}
            {...(onMarkContinueWatched !== undefined ? { onMarkContinueWatched } : {})}
          />
        ))}
      </HorizontalRailScroll>
    </View>
  );
}

/** Top `16:9` Continue Watching horizontal rail for Movies and Series discovery screens. */
export const CatalogContinueWatchingRail = memo(CatalogContinueWatchingRailInner);
CatalogContinueWatchingRail.displayName = 'CatalogContinueWatchingRail';

const styles = StyleSheet.create({
  section: { marginTop: 18 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  title: { flexShrink: 1 },
  stripContent: { alignItems: 'flex-start' },
});
