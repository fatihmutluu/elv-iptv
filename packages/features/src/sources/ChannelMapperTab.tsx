import type {
  CatalogService,
  ChannelGuideOverrideRecord,
  GuideChannelOption,
  ItemRow,
} from '@elv/data';
import {
  CtaButton,
  FilterChip,
  MicroPill,
  Surface,
  TABULAR_NUMS_STYLE,
  TvTextInput,
  useI18n,
  useTheme,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  type ChannelMapperFilter,
  clampOffsetHours,
  filterMapperChannels,
  formatSignedOffsetHours,
  MAX_EPG_OFFSET_HOURS,
  MIN_EPG_OFFSET_HOURS,
  offsetHoursToMs,
  offsetMsToHours,
  resolveChannelMappingStatus,
} from './guide-management-model';

const SEARCH_DEBOUNCE_MS = 180;
const GUIDE_PICKER_LIMIT = 40;

/** Props of {@link ChannelMapperTab}. */
export interface ChannelMapperTabProps {
  readonly sourceId: string;
  readonly catalog: CatalogService;
  readonly channels: readonly ItemRow[];
  readonly overrides: readonly ChannelGuideOverrideRecord[];
  readonly matchedKeys: ReadonlySet<string>;
  readonly isTv: boolean;
  readonly busy: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onRefresh: () => Promise<void>;
  readonly onMutated?: () => void;
}

/**
 * Manual Channel Mapper tab (`#30`): filter All / Unmatched live channels, search channels or
 * guide IDs, assign a specific XMLTV `guide_id`, set per-channel `-12h..+12h` offset, or reset to
 * automatic matching.
 */
export function ChannelMapperTab({
  sourceId,
  catalog,
  channels,
  overrides,
  matchedKeys,
  isTv,
  busy,
  onBusyChange,
  onRefresh,
  onMutated,
}: ChannelMapperTabProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const [filter, setFilter] = useState<ChannelMapperFilter>('all');
  const [searchDraft, setSearchDraft] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [editingChannelKey, setEditingChannelKey] = useState<string | null>(null);
  const [guideQuery, setGuideQuery] = useState('');
  const [guideOptions, setGuideOptions] = useState<readonly GuideChannelOption[]>([]);
  const [selectedGuideId, setSelectedGuideId] = useState<string | null>(null);
  const [offsetHours, setOffsetHours] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchDraft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft]);

  useEffect(() => {
    if (editingChannelKey === null || !catalog.listGuideChannels) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void catalog
        .listGuideChannels?.(sourceId, guideQuery, GUIDE_PICKER_LIMIT)
        .then((opts) => {
          if (!cancelled) setGuideOptions(opts);
        })
        .catch(() => undefined);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [catalog, editingChannelKey, guideQuery, sourceId]);

  const overridesByKey = useMemo(() => {
    const map = new Map<string, ChannelGuideOverrideRecord>();
    for (const row of overrides) map.set(row.channelKey, row);
    return map;
  }, [overrides]);

  const filteredChannels = useMemo(
    () => filterMapperChannels(channels, overridesByKey, matchedKeys, filter, debouncedQuery),
    [channels, debouncedQuery, filter, matchedKeys, overridesByKey],
  );

  const openEditor = useCallback(
    (ch: ItemRow) => {
      const existing = overridesByKey.get(ch.key);
      setEditingChannelKey(ch.key);
      setSelectedGuideId(existing?.guideId ?? null);
      setOffsetHours(offsetMsToHours(existing?.epgShiftMs));
      setGuideQuery('');
      if (catalog.listGuideChannels) {
        void catalog
          .listGuideChannels(sourceId, '', GUIDE_PICKER_LIMIT)
          .then((opts) => setGuideOptions(opts))
          .catch(() => undefined);
      }
    },
    [catalog, overridesByKey, sourceId],
  );

  const closeEditor = useCallback(() => {
    setEditingChannelKey(null);
    setSelectedGuideId(null);
    setGuideQuery('');
  }, []);

  const handleSaveOverride = useCallback(
    async (channelKey: string) => {
      if (!catalog.setChannelGuideOverride || busy) return;
      onBusyChange(true);
      try {
        const res = await catalog.setChannelGuideOverride({
          sourceId,
          channelKey,
          guideId: selectedGuideId,
          epgShiftMs: offsetHoursToMs(offsetHours),
        });
        if (res.ok) {
          closeEditor();
          await onRefresh();
          onMutated?.();
        }
      } finally {
        onBusyChange(false);
      }
    },
    [
      busy,
      catalog,
      closeEditor,
      offsetHours,
      onBusyChange,
      onMutated,
      onRefresh,
      selectedGuideId,
      sourceId,
    ],
  );

  const handleClearOverride = useCallback(
    async (channelKey: string) => {
      if (!catalog.clearChannelGuideOverride || busy) return;
      onBusyChange(true);
      try {
        const res = await catalog.clearChannelGuideOverride(sourceId, channelKey);
        if (res.ok) {
          if (editingChannelKey === channelKey) closeEditor();
          await onRefresh();
          onMutated?.();
        }
      } finally {
        onBusyChange(false);
      }
    },
    [busy, catalog, closeEditor, editingChannelKey, onBusyChange, onMutated, onRefresh, sourceId],
  );

  return (
    <View testID="channel-mapper-tab" style={styles.container}>
      <View style={styles.controlsRow}>
        <FilterChip
          testID="mapper-filter-all"
          label={i18n.t('sources.guides.filterAll')}
          selected={filter === 'all'}
          focusable={!isTv}
          onPress={() => setFilter('all')}
        />
        <FilterChip
          testID="mapper-filter-unmatched"
          label={i18n.t('sources.guides.filterUnmatched')}
          selected={filter === 'unmatched'}
          focusable={!isTv}
          onPress={() => setFilter('unmatched')}
        />
      </View>

      <TvTextInput
        testID="mapper-search-input"
        value={searchDraft}
        onChangeText={setSearchDraft}
        placeholder={i18n.t('sources.guides.searchPlaceholder')}
        placeholderTextColor={theme.colors.textMuted}
        accessibilityLabel={i18n.t('sources.guides.searchPlaceholder')}
        style={[
          styles.input,
          theme.typography.body,
          {
            color: theme.colors.textPrimary,
            backgroundColor: theme.colors.bgSurface,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.button,
          },
        ]}
      />

      <View style={styles.list}>
        {filteredChannels.map((ch) => {
          const override = overridesByKey.get(ch.key);
          const status = resolveChannelMappingStatus(ch.key, overridesByKey, matchedKeys);
          const isEditing = editingChannelKey === ch.key;
          const chOffsetHours = offsetMsToHours(override?.epgShiftMs);

          return (
            <Surface
              key={ch.key}
              testID={`mapper-channel-row-${ch.key}`}
              tone="card"
              bordered
              rounded="card"
              style={styles.channelRow}
            >
              <View style={styles.channelHeader}>
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.title,
                    styles.flex1,
                    { color: theme.colors.textPrimary },
                  ]}
                >
                  {ch.name}
                </Text>
                {status === 'manual' ? (
                  <MicroPill
                    testID={`mapper-badge-manual-${ch.key}`}
                    label={i18n.t('sources.guides.manualBadge')}
                    tone="accent"
                  />
                ) : status === 'unmatched' ? (
                  <MicroPill
                    testID={`mapper-badge-unmatched-${ch.key}`}
                    label={i18n.t('sources.guides.unmatchedBadge')}
                    tone="neutral"
                  />
                ) : null}
                {override?.guideId ? (
                  <Text
                    numberOfLines={1}
                    style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                  >
                    {override.guideId}
                  </Text>
                ) : null}
                {chOffsetHours !== 0 ? (
                  <MicroPill
                    label={i18n.t('sources.guides.offsetHours', {
                      hours: formatSignedOffsetHours(chOffsetHours),
                    })}
                    tone="neutral"
                  />
                ) : null}
              </View>

              {isEditing ? (
                <View testID={`mapper-editor-${ch.key}`} style={styles.editor}>
                  <TvTextInput
                    testID={`mapper-guide-search-${ch.key}`}
                    value={guideQuery}
                    onChangeText={setGuideQuery}
                    placeholder={i18n.t('sources.guides.searchPlaceholder')}
                    placeholderTextColor={theme.colors.textMuted}
                    accessibilityLabel={i18n.t('sources.guides.assignGuide')}
                    style={[
                      styles.input,
                      theme.typography.body,
                      {
                        color: theme.colors.textPrimary,
                        backgroundColor: theme.colors.bgSurface,
                        borderColor: theme.colors.surfaceBorder,
                        borderRadius: theme.radius.button,
                      },
                    ]}
                  />

                  {guideOptions.length === 0 ? (
                    <Text
                      testID="mapper-no-guide-channels"
                      style={[theme.typography.caption, { color: theme.colors.textMuted }]}
                    >
                      {i18n.t('sources.guides.noGuideChannels')}
                    </Text>
                  ) : (
                    <View style={styles.guideOptionsWrap}>
                      {guideOptions.slice(0, 12).map((opt) => (
                        <FilterChip
                          key={opt.guideId}
                          testID={`mapper-guide-option-${opt.guideId}`}
                          label={`${opt.name} (${opt.guideId})`}
                          selected={selectedGuideId === opt.guideId}
                          focusable={!isTv}
                          onPress={() => setSelectedGuideId(opt.guideId)}
                        />
                      ))}
                    </View>
                  )}

                  <View style={styles.offsetRow}>
                    <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                      {i18n.t('sources.guides.channelOffsetLabel')}
                    </Text>
                    <View style={styles.stepperGroup}>
                      <CtaButton
                        testID={`mapper-offset-dec-${ch.key}`}
                        variant="secondary"
                        label="-1h"
                        disabled={offsetHours <= MIN_EPG_OFFSET_HOURS}
                        focusable={!isTv}
                        onPress={() => setOffsetHours((h) => clampOffsetHours(h - 1))}
                      />
                      <Text
                        testID={`mapper-offset-value-${ch.key}`}
                        style={[
                          theme.typography.caption,
                          TABULAR_NUMS_STYLE,
                          styles.offsetValue,
                          { color: theme.colors.textPrimary },
                        ]}
                      >
                        {i18n.t('sources.guides.offsetHours', {
                          hours: formatSignedOffsetHours(offsetHours),
                        })}
                      </Text>
                      <CtaButton
                        testID={`mapper-offset-inc-${ch.key}`}
                        variant="secondary"
                        label="+1h"
                        disabled={offsetHours >= MAX_EPG_OFFSET_HOURS}
                        focusable={!isTv}
                        onPress={() => setOffsetHours((h) => clampOffsetHours(h + 1))}
                      />
                    </View>
                  </View>

                  <View style={styles.rowActions}>
                    <CtaButton
                      testID={`mapper-save-${ch.key}`}
                      variant="primary"
                      label={i18n.t('sources.guides.save')}
                      disabled={busy}
                      focusable={!isTv}
                      onPress={() => void handleSaveOverride(ch.key)}
                    />
                    <CtaButton
                      testID={`mapper-cancel-${ch.key}`}
                      variant="secondary"
                      label={i18n.t('sources.guides.cancel')}
                      disabled={busy}
                      focusable={!isTv}
                      onPress={closeEditor}
                    />
                  </View>
                </View>
              ) : (
                <View style={styles.rowActions}>
                  <CtaButton
                    testID={`mapper-assign-${ch.key}`}
                    variant="secondary"
                    label={i18n.t('sources.guides.assignGuide')}
                    disabled={busy}
                    focusable={!isTv}
                    onPress={() => openEditor(ch)}
                  />
                  {override !== undefined ? (
                    <CtaButton
                      testID={`mapper-clear-${ch.key}`}
                      variant="secondary"
                      label={i18n.t('sources.guides.clearOverride')}
                      disabled={busy}
                      focusable={!isTv}
                      onPress={() => void handleClearOverride(ch.key)}
                    />
                  ) : null}
                </View>
              )}
            </Surface>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  controlsRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 42,
  },
  list: { gap: 10 },
  channelRow: { padding: 12, gap: 10 },
  channelHeader: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  flex1: { flex: 1, minWidth: 120 },
  editor: { gap: 10, paddingTop: 4 },
  guideOptionsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  offsetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 10,
  },
  stepperGroup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  offsetValue: { minWidth: 44, textAlign: 'center', fontWeight: '700' },
  rowActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
});
