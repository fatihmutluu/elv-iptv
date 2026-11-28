import type { LiveFavoriteFolderRecord } from '@elv/data';
import { Icon, Tooltip, useI18n, useTheme, webCursorPointer, webTransition } from '@elv/ui-kit';
import { memo, type ReactElement, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { LiveFavoriteFolderFilter } from './useLiveFavoriteFolders';

/** One D-pad/pointer focusable slot in {@link LiveFavoriteFolderStrip}. */
export type LiveFavoriteFolderSlotAction =
  | { readonly kind: 'filter'; readonly filter: LiveFavoriteFolderFilter }
  | { readonly kind: 'manage'; readonly folder: LiveFavoriteFolderRecord }
  | { readonly kind: 'create' };

/**
 * Returns the ordered focusable slots rendered by {@link LiveFavoriteFolderStrip}
 * (`All`, optional `Unfiled`, custom folders, optional `Manage` button, and `+` create button).
 */
export function buildLiveFavoriteFolderSlots(
  folders: readonly LiveFavoriteFolderRecord[],
  activeFilter: LiveFavoriteFolderFilter,
): readonly LiveFavoriteFolderSlotAction[] {
  const slots: LiveFavoriteFolderSlotAction[] = [{ kind: 'filter', filter: 'all' }];
  if (folders.length > 0) slots.push({ kind: 'filter', filter: 'unfiled' });
  for (const folder of folders) slots.push({ kind: 'filter', filter: folder.id });
  const activeCustom =
    activeFilter !== 'all' && activeFilter !== 'unfiled'
      ? (folders.find((f) => f.id === activeFilter) ?? null)
      : null;
  if (activeCustom !== null) slots.push({ kind: 'manage', folder: activeCustom });
  slots.push({ kind: 'create' });
  return slots;
}

/** Props of {@link LiveFavoriteFolderStrip}. */
export interface LiveFavoriteFolderStripProps {
  readonly folders: readonly LiveFavoriteFolderRecord[];
  readonly activeFilter: LiveFavoriteFolderFilter;
  readonly isTv: boolean;
  /** Focused slot index for 10-ft TV D-pad navigation (`null` when strip does not hold TV focus). */
  readonly focusedSlotIndex?: number | null;
  readonly onSelectFilter: (next: LiveFavoriteFolderFilter) => void;
  readonly onRequestCreate: () => void;
  readonly onRequestManage: (folder: LiveFavoriteFolderRecord) => void;
}

interface FolderTab {
  readonly id: LiveFavoriteFolderFilter;
  readonly label: string;
  readonly testID: string;
}

/**
 * Cinema Quietude v2 borderless editorial underline filter strip rendered strictly inside
 * `LiveZapDrawer` (`All` | `Unfiled` | custom folders + subtle `+` create & active folder manage).
 * Zero pill-bubble chips, zero boxed cards, zero top canvas action-bar clutter.
 */
export const LiveFavoriteFolderStrip = memo(function LiveFavoriteFolderStripInner({
  folders,
  activeFilter,
  isTv,
  focusedSlotIndex = null,
  onSelectFilter,
  onRequestCreate,
  onRequestManage,
}: LiveFavoriteFolderStripProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'color, background-color, opacity');

  const tabs = useMemo<readonly FolderTab[]>(() => {
    const out: FolderTab[] = [
      { id: 'all', label: i18n.t('live.folders.all'), testID: 'live-folder-tab-all' },
    ];
    if (folders.length > 0) {
      out.push({
        id: 'unfiled',
        label: i18n.t('live.folders.unfiled'),
        testID: 'live-folder-tab-unfiled',
      });
    }
    for (const folder of folders) {
      out.push({
        id: folder.id,
        label: folder.name,
        testID: `live-folder-tab-${folder.id}`,
      });
    }
    return out;
  }, [folders, i18n]);

  const activeCustomFolder = useMemo(
    () =>
      activeFilter !== 'all' && activeFilter !== 'unfiled'
        ? (folders.find((f) => f.id === activeFilter) ?? null)
        : null,
    [activeFilter, folders],
  );

  const manageSlotIndex = activeCustomFolder !== null ? tabs.length : -1;
  const createSlotIndex = tabs.length + (activeCustomFolder !== null ? 1 : 0);

  return (
    <View
      testID="live-favorite-folder-strip"
      style={[styles.root, { borderBottomColor: theme.colors.surfaceBorder }]}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabRow}
        style={styles.scroll}
      >
        {tabs.map((tab, idx) => {
          const isActive = tab.id === activeFilter;
          const isHovered = hoveredId === tab.id;
          const isFocused = isTv && focusedSlotIndex === idx;
          const textColor =
            isActive || isHovered || isFocused
              ? theme.colors.textPrimary
              : theme.colors.textSecondary;
          return (
            <Pressable
              key={tab.id}
              testID={tab.testID}
              accessibilityRole="tab"
              accessibilityLabel={tab.label}
              accessibilityState={{ selected: isActive }}
              focusable={!isTv}
              onPress={() => onSelectFilter(tab.id)}
              onHoverIn={() => setHoveredId(tab.id)}
              onHoverOut={() => setHoveredId((prev) => (prev === tab.id ? null : prev))}
              style={[
                styles.tab,
                isFocused
                  ? {
                      backgroundColor: theme.colors.focusFill,
                      borderColor: theme.colors.focusRingColor,
                      borderWidth: 1,
                      borderRadius: theme.radius.button,
                      paddingHorizontal: 8,
                    }
                  : undefined,
                cursor,
                transition,
              ]}
            >
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.caption,
                  { color: textColor, fontWeight: isActive || isFocused ? '700' : '500' },
                ]}
              >
                {tab.label}
              </Text>
              <View
                style={[
                  styles.activeBar,
                  { backgroundColor: isActive ? theme.colors.accent : 'transparent' },
                ]}
              />
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.actions}>
        {activeCustomFolder !== null ? (
          <Tooltip content={i18n.t('live.folders.manageFolder')}>
            <Pressable
              testID="live-folder-manage-btn"
              accessibilityRole="button"
              accessibilityLabel={i18n.t('live.folders.manageFolder')}
              focusable={!isTv}
              onPress={() => onRequestManage(activeCustomFolder)}
              style={({ pressed }) => {
                const isFocused = isTv && focusedSlotIndex === manageSlotIndex;
                return [
                  styles.iconBtn,
                  {
                    borderRadius: theme.radius.button,
                    backgroundColor: isFocused
                      ? theme.colors.focusFill
                      : pressed
                        ? theme.colors.subtleHighlight
                        : 'transparent',
                    borderColor: isFocused ? theme.colors.focusRingColor : 'transparent',
                    borderWidth: isFocused ? 1 : 0,
                  },
                  cursor,
                  transition,
                ];
              }}
            >
              <Icon
                name="dots"
                size={15}
                color={
                  isTv && focusedSlotIndex === manageSlotIndex
                    ? theme.colors.textPrimary
                    : theme.colors.textSecondary
                }
              />
            </Pressable>
          </Tooltip>
        ) : null}
        <Tooltip content={i18n.t('live.folders.createTooltip')}>
          <Pressable
            testID="live-folder-create-btn"
            accessibilityRole="button"
            accessibilityLabel={i18n.t('live.folders.createTooltip')}
            focusable={!isTv}
            onPress={onRequestCreate}
            style={({ pressed }) => {
              const isFocused = isTv && focusedSlotIndex === createSlotIndex;
              return [
                styles.iconBtn,
                {
                  borderRadius: theme.radius.button,
                  backgroundColor: isFocused
                    ? theme.colors.focusFill
                    : pressed
                      ? theme.colors.subtleHighlight
                      : 'transparent',
                  borderColor: isFocused ? theme.colors.focusRingColor : 'transparent',
                  borderWidth: isFocused ? 1 : 0,
                },
                cursor,
                transition,
              ];
            }}
          >
            <Icon
              name="plus"
              size={15}
              color={
                isTv && focusedSlotIndex === createSlotIndex
                  ? theme.colors.textPrimary
                  : theme.colors.textSecondary
              }
            />
          </Pressable>
        </Tooltip>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingLeft: 10,
    paddingRight: 6,
    minHeight: 38,
    gap: 6,
  },
  scroll: { flex: 1, minWidth: 0 },
  tabRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingRight: 6 },
  tab: {
    position: 'relative',
    paddingVertical: 10,
    justifyContent: 'center',
    maxWidth: 132,
  },
  activeBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    borderRadius: 1,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  iconBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
