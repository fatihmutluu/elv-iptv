import type { ItemRow } from '@elv/data';
import type { FocusStore } from '@elv/focus-core';
import { ElvList, type ListSource, TvFocusAnchor, useI18n, useKeyInterpreter } from '@elv/ui-kit';
import { type ReactElement, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouteActive } from '../shared';
import { type DisplayCategory, formatItemTitle } from './browse-model';

export const BROWSE_VISIBLE_ROWS = 10;
export const BROWSE_ROW_HEIGHT_TV = 50;
export const BROWSE_ROW_HEIGHT_POINTER = 44;
export const CATEGORIES_LIST_ID = 'browse-categories';
export const ITEMS_LIST_ID = 'browse-items';

/** Wraps a small in-memory array (`categories`, `seasons`, `episodes`) as an O(1) {@link ListSource}. */
export function createArrayListSource<T>(items: readonly T[]): ListSource<T> {
  return {
    count: () => items.length,
    get: (index) => (index >= 0 && index < items.length ? items[index] : undefined),
    prefetch: () => undefined,
    onChange: () => () => undefined,
  };
}

/** Subscribes to TV remote keys only while mounted (when the owning browse pane is active on TV). */
export function BrowseTvKeyBridge({
  onEvent,
}: {
  onEvent: Parameters<typeof useKeyInterpreter>[0];
}): ReactElement {
  const routeActive = useRouteActive();
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="browse-tv-focus-anchor" hasTVPreferredFocus={routeActive} />;
}

/** Plain monochrome header/action button that disables Android native focus when `isTv` is true. */
export function PlainBrowseButton({
  label,
  testID,
  isTv,
  highlighted = false,
  onPress,
}: {
  label: string;
  testID: string;
  isTv: boolean;
  highlighted?: boolean;
  onPress: () => void;
}): ReactElement {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(isTv ? { focusable: false } : {})}
      onPress={onPress}
      style={[browseStyles.button, highlighted ? browseStyles.buttonHighlighted : null]}
    >
      <Text
        style={[
          browseStyles.buttonText,
          isTv ? browseStyles.buttonTextTv : null,
          highlighted ? browseStyles.buttonTextHighlighted : null,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Renders a single plain monochrome row inside `ElvList`. */
export function PlainListRow({
  text,
  active,
  isTv,
}: {
  text: string;
  active: boolean;
  isTv: boolean;
}): ReactElement {
  return (
    <View style={[browseStyles.row, active ? browseStyles.rowActive : null]}>
      <Text
        numberOfLines={1}
        style={[
          browseStyles.rowText,
          isTv ? browseStyles.rowTextTv : null,
          active ? browseStyles.rowTextActive : null,
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

/** Two-column (or single-pane phone) Categories + Items layout for {@link BrowseScreen}. */
export function BrowseCategoriesAndItems({
  isTv,
  isPhone,
  rowHeight,
  store,
  categoriesSource,
  itemsSource,
  activeCategory,
  activeItemCount,
  selectedCatIdx,
  safeItemIdx,
  activePane,
  onSelectCategory,
  onActivateCategory,
  onBackToCategories,
  onSelectItem,
  onActivateItem,
}: {
  isTv: boolean;
  isPhone: boolean;
  rowHeight: number;
  store: FocusStore;
  categoriesSource: ListSource<DisplayCategory>;
  itemsSource: ListSource<ItemRow> | null;
  activeCategory: DisplayCategory | undefined;
  activeItemCount: number;
  selectedCatIdx: number;
  safeItemIdx: number;
  activePane: 'categories' | 'items';
  onSelectCategory: (index: number) => void;
  onActivateCategory: (index: number) => void;
  onBackToCategories: () => void;
  onSelectItem: (index: number) => void;
  onActivateItem: (index: number) => void;
}): ReactElement {
  const i18n = useI18n();

  const categoryRowLabel = useCallback(
    (cat: DisplayCategory | undefined) =>
      cat === undefined
        ? i18n.t('browse.loading')
        : i18n.t('browse.categoryCount', { name: cat.label, count: cat.row.itemCount }),
    [i18n],
  );
  const renderCategoryRow = useCallback(
    (cat: DisplayCategory | undefined, active: boolean) => (
      <PlainListRow text={categoryRowLabel(cat)} active={active} isTv={isTv} />
    ),
    [categoryRowLabel, isTv],
  );

  const itemRowLabel = useCallback(
    (item: ItemRow | undefined) =>
      item === undefined ? i18n.t('browse.loading') : formatItemTitle(item),
    [i18n],
  );
  const renderItemRow = useCallback(
    (item: ItemRow | undefined, active: boolean) => (
      <PlainListRow text={itemRowLabel(item)} active={active} isTv={isTv} />
    ),
    [isTv, itemRowLabel],
  );

  const categoriesPane = (
    <View style={isPhone ? browseStyles.singlePane : browseStyles.leftColumn}>
      <View style={browseStyles.paneHeader}>
        <Text style={[browseStyles.paneTitle, isTv ? browseStyles.paneTitleTv : null]}>
          {i18n.t('browse.categories')}
        </Text>
      </View>
      <ElvList
        listId={CATEGORIES_LIST_ID}
        store={store}
        source={categoriesSource}
        rowHeight={rowHeight}
        visibleRows={BROWSE_VISIBLE_ROWS}
        selectedIndex={selectedCatIdx}
        onSelectIndex={onSelectCategory}
        onActivateIndex={onActivateCategory}
        renderRow={renderCategoryRow}
        rowLabel={categoryRowLabel}
        testID="browse-categories-list"
      />
    </View>
  );

  const itemsPane = (
    <View style={isPhone ? browseStyles.singlePane : browseStyles.rightColumn}>
      <View style={browseStyles.paneHeader}>
        <Text style={[browseStyles.paneTitle, isTv ? browseStyles.paneTitleTv : null]}>
          {activeCategory?.label ?? i18n.t('browse.items')}
        </Text>
        {isPhone ? (
          <PlainBrowseButton
            testID="browse-back-categories"
            label={i18n.t('browse.backToCategories')}
            isTv={isTv}
            onPress={onBackToCategories}
          />
        ) : null}
      </View>
      {activeItemCount <= 0 || itemsSource === null ? (
        <View style={browseStyles.emptyBox}>
          <Text style={[browseStyles.messageText, isTv ? browseStyles.messageTextTv : null]}>
            {activeItemCount <= 0 ? i18n.t('browse.emptyItems') : i18n.t('browse.loading')}
          </Text>
        </View>
      ) : (
        <ElvList
          listId={ITEMS_LIST_ID}
          store={store}
          source={itemsSource}
          rowHeight={rowHeight}
          visibleRows={BROWSE_VISIBLE_ROWS}
          selectedIndex={safeItemIdx}
          onSelectIndex={onSelectItem}
          onActivateIndex={onActivateItem}
          renderRow={renderItemRow}
          rowLabel={itemRowLabel}
          testID="browse-items-list"
        />
      )}
    </View>
  );

  if (isPhone) {
    return activePane === 'items' ? itemsPane : categoriesPane;
  }
  return (
    <View style={browseStyles.splitRow}>
      {categoriesPane}
      {itemsPane}
    </View>
  );
}

export const browseStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  rootTv: { paddingHorizontal: 48, paddingVertical: 20 },
  rootPointer: { paddingHorizontal: 16, paddingVertical: 12 },
  splitRow: { flex: 1, flexDirection: 'row', gap: 16 },
  singlePane: { flex: 1 },
  leftColumn: {
    width: 300,
    backgroundColor: '#121212',
    borderWidth: 1,
    borderColor: '#262626',
    padding: 12,
  },
  rightColumn: {
    flex: 1,
    backgroundColor: '#121212',
    borderWidth: 1,
    borderColor: '#262626',
    padding: 12,
  },
  paneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 10,
  },
  paneTitle: { color: '#d4d4d4', fontSize: 15, fontWeight: '700', flexShrink: 1 },
  paneTitleTv: { fontSize: 20 },
  row: { flex: 1, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 4 },
  rowActive: { backgroundColor: '#242424' },
  rowText: { color: '#d4d4d4', fontSize: 15 },
  rowTextTv: { fontSize: 18 },
  rowTextActive: { color: '#ffffff', fontWeight: '700' },
  emptyBox: { flex: 1, justifyContent: 'center', alignItems: 'flex-start', padding: 20, gap: 12 },
  messageText: { color: '#e5e5e5', fontSize: 16 },
  messageTextTv: { fontSize: 20 },
  hintText: { color: '#a3a3a3', fontSize: 14 },
  hintTextTv: { fontSize: 18 },
  button: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#525252',
    backgroundColor: '#171717',
  },
  buttonHighlighted: { borderColor: '#ffffff', backgroundColor: '#262626' },
  buttonText: { color: '#f5f5f5', fontSize: 14, fontWeight: '600' },
  buttonTextTv: { fontSize: 18 },
  buttonTextHighlighted: { color: '#ffffff' },
});
