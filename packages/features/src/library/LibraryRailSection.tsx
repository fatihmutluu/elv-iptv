import {
  type ContextMenuAnchor,
  HorizontalRailScroll,
  Icon,
  IconButton,
  MicroPill,
  PosterCard,
  useI18n,
  useTheme,
  WideCard,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ComponentRef, type ReactElement, useEffect, useRef } from 'react';
import { type LayoutChangeEvent, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { LibraryCardItem } from './library-model';
import type { LibraryDropRect, LibraryDropZoneSource } from './useLibraryFolderDrag';

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
  readonly isCollection?: boolean;
  readonly collectionId?: string;
  readonly focusedHeaderAction?: 'rename' | 'delete' | null;
  readonly onRenameCollection?: () => void;
  readonly onDeleteCollection?: () => void;
  readonly dropZoneTargetId?: string;
  readonly isDropTargetHovered?: boolean;
  readonly onRegisterDropZone?: (targetId: string, source: LibraryDropZoneSource | null) => void;
  readonly onStartCardDrag?: (
    item: LibraryCardItem,
    sourceCollectionId: string | null,
    clientX: number,
    clientY: number,
  ) => void;
  readonly wasRecentlyDragging?: () => boolean;
  readonly onPressItem: (item: LibraryCardItem) => void;
  readonly onContextMenuItem?: (item: LibraryCardItem, anchor?: ContextMenuAnchor) => void;
  readonly onSeeAll?: () => void;
}

interface WebMeasureableNode {
  getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
}

/**
 * One horizontal editorial rail inside {@link LibraryScreen} with `See all ›` drill-down,
 * folder-style custom collection controls (Rename, Delete, empty drop-zone hint), and
 * web/desktop pointer drag-and-drop highlighting.
 */
export function LibraryRailSection({
  railId,
  title,
  items,
  variant,
  cardWidth,
  padX,
  isTv,
  focusedCardIndex = null,
  isCollection = false,
  collectionId,
  focusedHeaderAction = null,
  onRenameCollection,
  onDeleteCollection,
  dropZoneTargetId,
  isDropTargetHovered = false,
  onRegisterDropZone,
  onStartCardDrag,
  wasRecentlyDragging,
  onPressItem,
  onContextMenuItem,
  onSeeAll,
}: LibraryRailSectionProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'opacity, color, border-color, background-color');

  const sectionRef = useRef<ComponentRef<typeof View> | null>(null);
  const layoutRectRef = useRef<LibraryDropRect | null>(null);
  const visible = isCollection || items.length > 0;

  useEffect(() => {
    if (!visible || !dropZoneTargetId || !onRegisterDropZone) return undefined;
    const resolveRect = (): LibraryDropRect | null => {
      const node = sectionRef.current as unknown as WebMeasureableNode | null;
      if (Platform.OS === 'web' && typeof node?.getBoundingClientRect === 'function') {
        const b = node.getBoundingClientRect();
        if (b.width > 0 || b.height > 0) {
          return { x: b.left, y: b.top, width: b.width, height: b.height };
        }
      }
      return layoutRectRef.current;
    };
    onRegisterDropZone(dropZoneTargetId, resolveRect);
    return () => {
      onRegisterDropZone(dropZoneTargetId, null);
    };
  }, [dropZoneTargetId, onRegisterDropZone, visible]);

  if (!visible) return null;

  const cardGap = isTv ? 18 : 14;
  const renameFocused = isTv && focusedHeaderAction === 'rename';
  const deleteFocused = isTv && focusedHeaderAction === 'delete';

  const handleLayout = (event: LayoutChangeEvent) => {
    const { x, y, width, height } = event.nativeEvent.layout;
    layoutRectRef.current = { x, y, width, height };
  };

  return (
    <View
      ref={sectionRef}
      testID={`library-rail-${railId}`}
      onLayout={dropZoneTargetId ? handleLayout : undefined}
      style={[
        styles.section,
        isDropTargetHovered
          ? {
              borderWidth: 2,
              borderColor: theme.colors.accent,
              borderRadius: theme.radius.card,
              backgroundColor: theme.colors.accentTint,
              paddingVertical: 8,
            }
          : null,
      ]}
    >
      <View style={[styles.headerRow, { paddingHorizontal: padX }]}>
        <View style={styles.titleCluster}>
          <Text
            numberOfLines={1}
            style={[theme.typography.h2, styles.title, { color: theme.colors.textPrimary }]}
          >
            {title}
          </Text>
          {isDropTargetHovered ? (
            <MicroPill
              testID={`library-drop-badge-${railId}`}
              label={i18n.t('library.collections.dropHere')}
              tone="accent"
            />
          ) : null}
        </View>

        <View style={styles.headerActions}>
          {isCollection && collectionId !== undefined && onRenameCollection !== undefined ? (
            <Pressable
              testID={`library-collection-rename-${collectionId}`}
              accessibilityRole="button"
              accessibilityLabel={`${i18n.t('library.collections.rename')} — ${title}`}
              focusable={!isTv}
              onPress={onRenameCollection}
              style={({ pressed }) => [
                styles.collectionActionBtn,
                cursor,
                transition,
                {
                  borderRadius: theme.radius.button,
                  borderColor: renameFocused
                    ? theme.colors.focusRingColor
                    : theme.colors.surfaceBorder,
                  borderWidth: renameFocused ? theme.focus.ringWidth : 1,
                  backgroundColor: renameFocused ? theme.colors.focusFill : theme.colors.bgSurface,
                  opacity: pressed ? 0.75 : 1,
                },
              ]}
            >
              <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
                {i18n.t('library.collections.rename')}
              </Text>
            </Pressable>
          ) : null}

          {isCollection && collectionId !== undefined && onDeleteCollection !== undefined ? (
            <IconButton
              testID={`library-collection-delete-${collectionId}`}
              icon="trash"
              size={34}
              accessibilityLabel={`${i18n.t('library.collections.delete')} — ${title}`}
              focusable={!isTv}
              focused={deleteFocused}
              onPress={onDeleteCollection}
            />
          ) : null}

          {items.length > 0 && onSeeAll !== undefined ? (
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
      </View>

      {isCollection && items.length === 0 ? (
        <View
          testID={`library-collection-empty-${collectionId ?? railId}`}
          style={[
            styles.emptyCollectionZone,
            {
              marginHorizontal: padX,
              borderRadius: theme.radius.card,
              borderColor: isDropTargetHovered ? theme.colors.accent : theme.colors.surfaceBorder,
              backgroundColor: theme.colors.bgCard,
              paddingHorizontal: theme.spacing.md,
              paddingVertical: theme.spacing.md,
            },
          ]}
        >
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('library.collections.emptySection')}
          </Text>
        </View>
      ) : (
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
            const canDrag =
              !isTv &&
              Platform.OS === 'web' &&
              onStartCardDrag !== undefined &&
              (item.kind === 'movie' || item.kind === 'series');
            const webDragProps = canDrag
              ? ({
                  onPointerDown: (e: { clientX?: number; clientY?: number; button?: number }) => {
                    if (typeof e.button === 'number' && e.button !== 0) return;
                    onStartCardDrag(
                      item,
                      isCollection ? (collectionId ?? null) : null,
                      typeof e.clientX === 'number' ? e.clientX : 0,
                      typeof e.clientY === 'number' ? e.clientY : 0,
                    );
                  },
                } as Record<string, unknown>)
              : undefined;
            const card = (
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
                onPress={() => {
                  if (wasRecentlyDragging?.()) return;
                  onPressItem(item);
                }}
                {...(handleContext !== undefined ? { onContextMenu: handleContext } : {})}
              />
            );
            if (!webDragProps) return card;
            return (
              <View
                key={item.id}
                testID={`library-drag-card-${railId}-${item.id}`}
                {...webDragProps}
              >
                {card}
              </View>
            );
          })}
        </HorizontalRailScroll>
      )}
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
  titleCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
    minWidth: 0,
  },
  title: {
    flexShrink: 1,
    minWidth: 0,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  collectionActionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 34,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyCollectionZone: {
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  seeAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
});
