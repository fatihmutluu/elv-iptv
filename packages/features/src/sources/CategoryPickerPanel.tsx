import type { BrowseKind, DiscoveredCategory } from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import {
  hexToRgba,
  MicroPill,
  Surface,
  TABULAR_NUMS_STYLE,
  useFormFactor,
  useTheme,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { discoveredCategoryKey } from './category-selection-model';
import type { DescribedSourceFailure } from './errors';
import { ActionButton } from './SourcesScreenParts';
import type { ControlLayoutRecorder } from './useTvSourcesNavigation';

/** Props of {@link CategoryPickerPanel}. */
export interface CategoryPickerPanelProps {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly categories: readonly DiscoveredCategory[];
  readonly selectedKeys: ReadonlySet<string>;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: DescribedSourceFailure | null;
  readonly i18n: AppI18n;
  readonly tvFocusId?: string | undefined;
  readonly recordLayout?: ControlLayoutRecorder | undefined;
  readonly onToggle: (key: string) => void;
  readonly onSelectAll: () => void;
  readonly onClearAll: () => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

const KIND_ORDER: readonly BrowseKind[] = ['live', 'movie', 'series'];

/** Cinema Quietude pre-import category selection panel grouped by Live / Movies / Series (`#39`). */
export function CategoryPickerPanel({
  sourceId,
  sourceName,
  categories,
  selectedKeys,
  loading,
  saving,
  error,
  i18n,
  tvFocusId,
  recordLayout,
  onToggle,
  onSelectAll,
  onClearAll,
  onConfirm,
  onCancel,
}: CategoryPickerPanelProps): ReactElement {
  const theme = useTheme();
  const isTv = useFormFactor() === 'tv';
  const total = categories.length;
  const selectedCount = selectedKeys.size;

  const kindLabel = (kind: BrowseKind): string => {
    if (kind === 'live') return i18n.t('nav.live');
    if (kind === 'movie') return i18n.t('nav.movies');
    return i18n.t('nav.series');
  };

  const categoryGroups = KIND_ORDER.map((kind) => {
    const group = categories.filter((c) => c.kind === kind);
    if (group.length === 0) return null;
    return (
      <View key={kind} style={styles.group}>
        <Text
          style={[
            theme.typography.caption,
            styles.groupTitle,
            { color: theme.colors.textSecondary },
          ]}
        >
          {kindLabel(kind)}
        </Text>
        {group.map((cat) => {
          const key = discoveredCategoryKey(cat.kind, cat.id);
          const focusId = `category-item-${key}`;
          const checked = selectedKeys.has(key);
          const itemFocused = tvFocusId === focusId;
          return (
            <View
              key={key}
              ref={(node) => recordLayout?.(focusId, node)}
              testID={`sources-focus-${focusId}`}
              onLayout={(e) => recordLayout?.(focusId, null, e)}
            >
              <Pressable
                testID={`category-picker-item-${cat.kind}-${cat.id}`}
                {...(isTv ? { focusable: false } : {})}
                accessibilityRole="checkbox"
                accessibilityState={{ checked, selected: itemFocused }}
                accessibilityLabel={`${cat.name} (${cat.itemCount})`}
                onPress={() => onToggle(key)}
                style={[
                  styles.itemRow,
                  {
                    borderRadius: theme.radius.button,
                    borderColor: itemFocused
                      ? theme.colors.focusRingColor
                      : checked
                        ? theme.colors.accent
                        : theme.colors.surfaceBorder,
                    borderWidth: itemFocused ? theme.focus.ringWidth : 1,
                    backgroundColor: itemFocused
                      ? theme.colors.focusFill
                      : checked
                        ? theme.colors.accentTint
                        : theme.colors.bgCard,
                  },
                ]}
              >
                {itemFocused ? (
                  <View
                    pointerEvents="none"
                    testID={`category-picker-item-${cat.kind}-${cat.id}-focus-ring`}
                    style={[
                      styles.focusRing,
                      {
                        borderRadius: theme.radius.button + 4,
                        borderWidth: theme.focus.ringWidth,
                        borderColor: theme.colors.focusRingColor,
                      },
                    ]}
                  />
                ) : null}
                <View
                  style={[
                    styles.checkbox,
                    {
                      borderColor: checked ? theme.colors.accent : theme.colors.surfaceBorder,
                      backgroundColor: checked ? theme.colors.accent : 'transparent',
                    },
                  ]}
                />
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.body,
                    styles.itemName,
                    { color: theme.colors.textPrimary },
                  ]}
                >
                  {cat.name}
                </Text>
                <MicroPill label={String(cat.itemCount)} tone="neutral" />
              </Pressable>
            </View>
          );
        })}
      </View>
    );
  });

  return (
    <Surface
      testID={`category-picker-${sourceId}`}
      tone="surface"
      bordered
      rounded="modal"
      style={styles.panel}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
            {i18n.t('sources.categoriesStepTitle')}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {sourceName}
          </Text>
        </View>
        {!loading && total > 0 ? (
          <Text
            testID="category-picker-summary"
            style={[
              theme.typography.caption,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textSecondary },
            ]}
          >
            {i18n.t('sources.categoriesSelectedCount', { selected: selectedCount, total })}
          </Text>
        ) : null}
      </View>

      {loading ? (
        <Text
          testID="category-picker-loading"
          style={[theme.typography.body, { color: theme.colors.textSecondary }]}
        >
          {i18n.t('sources.discoveringCategories')}
        </Text>
      ) : error !== null ? (
        <View
          testID="category-picker-error"
          style={[
            styles.errorBox,
            {
              backgroundColor: hexToRgba(theme.colors.liveColor, 0.14),
              borderColor: theme.colors.liveColor,
              borderRadius: theme.radius.card,
            },
          ]}
        >
          <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
            {i18n.t(error.messageId)}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t(error.hintId)}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.bulkActions}>
            <ActionButton
              focusId="category-select-all"
              testID="category-picker-select-all"
              label={i18n.t('sources.selectAllCategories')}
              tvFocused={tvFocusId === 'category-select-all'}
              onPress={onSelectAll}
              recordLayout={recordLayout}
            />
            <ActionButton
              focusId="category-clear-all"
              testID="category-picker-clear-all"
              label={i18n.t('sources.clearCategories')}
              tvFocused={tvFocusId === 'category-clear-all'}
              onPress={onClearAll}
              recordLayout={recordLayout}
            />
          </View>

          {isTv ? (
            <View style={styles.listContent}>{categoryGroups}</View>
          ) : (
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {categoryGroups}
            </ScrollView>
          )}
        </>
      )}

      <View style={styles.footer}>
        <ActionButton
          focusId="category-cancel"
          testID="category-picker-cancel"
          label={i18n.t('sources.action.cancel')}
          tvFocused={tvFocusId === 'category-cancel'}
          onPress={onCancel}
          recordLayout={recordLayout}
        />
        {!loading && error === null ? (
          <ActionButton
            focusId="category-confirm"
            testID="category-picker-confirm"
            label={i18n.t('sources.importSelected')}
            primary
            disabled={saving}
            tvFocused={tvFocusId === 'category-confirm'}
            onPress={onConfirm}
            recordLayout={recordLayout}
          />
        ) : null}
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  panel: { padding: 18, gap: 14, width: '100%' },
  focusRing: { position: 'absolute', top: -4, bottom: -4, left: -4, right: -4 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  headerText: { gap: 2, flexShrink: 1 },
  bulkActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  list: { maxHeight: 360 },
  listContent: { gap: 12 },
  group: { gap: 6 },
  groupTitle: { fontWeight: '600' },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    minHeight: 40,
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1.5,
  },
  itemName: { flex: 1 },
  errorBox: { padding: 12, borderWidth: 1, gap: 4 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 10 },
});
