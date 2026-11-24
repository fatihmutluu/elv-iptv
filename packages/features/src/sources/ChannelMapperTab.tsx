import type {
  CatalogService,
  ChannelGuideOverrideRecord,
  GuideChannelOption,
  ItemRow,
} from '@elv/data';
import type { KeyInput } from '@elv/focus-core';
import {
  CtaButton,
  FilterChip,
  MicroPill,
  Surface,
  TvTextInput,
  type TvTextInputInstance,
  useI18n,
  useTheme,
} from '@elv/ui-kit';
import {
  type MutableRefObject,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ChannelMapperEditor } from './ChannelMapperEditor';
import {
  buildChannelMapperFocusRows,
  type ChannelMapperFilter,
  clampOffsetHours,
  filterMapperChannels,
  formatSignedOffsetHours,
  mapperRowSlotCount,
  offsetHoursToMs,
  offsetMsToHours,
  resolveChannelMappingStatus,
} from './guide-management-model';

const SEARCH_DEBOUNCE_MS = 180;
const GUIDE_PICKER_LIMIT = 40;
const CATALOG_SEARCH_LIMIT = 200;
const NOW_NEXT_CHUNK = 50;

/** Props of {@link ChannelMapperTab}. */
export interface ChannelMapperTabProps {
  readonly sourceId: string;
  readonly catalog: CatalogService;
  readonly channels: readonly ItemRow[];
  readonly overrides: readonly ChannelGuideOverrideRecord[];
  readonly matchedKeys: ReadonlySet<string>;
  readonly hasMoreChannels?: boolean;
  readonly loadingMore?: boolean;
  readonly onLoadMore?: () => Promise<void>;
  readonly isTv: boolean;
  readonly tvActive?: boolean;
  readonly tvKeyHandlerRef?: MutableRefObject<((key: KeyInput['key']) => boolean) | null>;
  readonly onEdgeTop?: () => void;
  readonly onScrollToY?: (y: number) => void;
  readonly busy: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onRefresh: () => Promise<void>;
  readonly onMutated?: () => void;
}

/**
 * Manual Channel Mapper tab (`#30`): filter All / Unmatched live channels, search across the full
 * source catalog (uncapped past 200 channels), assign a specific XMLTV `guide_id` (preserving
 * `guideSourceId`), set per-channel `-12h..+12h` offset, reset to automatic, and navigate via TV D-pad.
 */
export function ChannelMapperTab({
  sourceId,
  catalog,
  channels,
  overrides,
  matchedKeys,
  hasMoreChannels = false,
  loadingMore = false,
  onLoadMore,
  isTv,
  tvActive = false,
  tvKeyHandlerRef,
  onEdgeTop,
  onScrollToY,
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
  const [remoteChannels, setRemoteChannels] = useState<readonly ItemRow[] | null>(null);
  const [remoteMatchedKeys, setRemoteMatchedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [editingChannelKey, setEditingChannelKey] = useState<string | null>(null);
  const [guideQuery, setGuideQuery] = useState('');
  const [guideOptions, setGuideOptions] = useState<readonly GuideChannelOption[]>([]);
  const [selectedGuideId, setSelectedGuideId] = useState<string | null>(null);
  const [selectedGuideSourceId, setSelectedGuideSourceId] = useState<string | null>(null);
  const [offsetHours, setOffsetHours] = useState(0);

  const [focusedRow, setFocusedRow] = useState(0);
  const [focusedCol, setFocusedCol] = useState(0);
  const searchInputRef = useRef<TvTextInputInstance | null>(null);
  const guideSearchInputRef = useRef<TvTextInputInstance | null>(null);
  const listYRef = useRef(0);
  const rowYRef = useRef<Record<string, number>>({});
  const loadMoreYRef = useRef(0);
  const guideReqSeqRef = useRef(0);
  const searchSeqRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchDraft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft]);

  // Catalog-side channel search so sources with >200 live channels can find & map any channel (#14).
  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    const seq = ++searchSeqRef.current;
    if (trimmed.length === 0 || catalog.search === undefined) {
      setRemoteChannels(null);
      setRemoteMatchedKeys(new Set());
      return;
    }
    let cancelled = false;
    void catalog
      .search(trimmed, { scope: 'live', sourceId, limit: CATALOG_SEARCH_LIMIT })
      .then(async (res) => {
        if (cancelled || seq !== searchSeqRef.current) return;
        const hits = res.live.filter((item) => item.sourceId === sourceId);
        const foundMatched = new Set<string>();
        if (catalog.nowNext && hits.length > 0) {
          const now = Date.now();
          for (let i = 0; i < hits.length; i += NOW_NEXT_CHUNK) {
            const chunk = hits.slice(i, i + NOW_NEXT_CHUNK).map((c) => c.key);
            const entries = await catalog.nowNext(chunk, now).catch(() => []);
            if (cancelled || seq !== searchSeqRef.current) return;
            for (const entry of entries) {
              if (entry.now !== null || entry.next !== null) foundMatched.add(entry.channelKey);
            }
          }
        }
        if (cancelled || seq !== searchSeqRef.current) return;
        setRemoteChannels(hits);
        setRemoteMatchedKeys(foundMatched);
      })
      .catch(() => {
        if (!cancelled && seq === searchSeqRef.current) {
          setRemoteChannels(null);
          setRemoteMatchedKeys(new Set());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [catalog, debouncedQuery, sourceId]);

  // Single guarded guide-channel options fetch (eliminates duplicate openEditor fetch, #14).
  useEffect(() => {
    if (editingChannelKey === null || !catalog.listGuideChannels) return;
    let cancelled = false;
    const reqSeq = ++guideReqSeqRef.current;
    const run = () => {
      void catalog
        .listGuideChannels?.(sourceId, guideQuery, GUIDE_PICKER_LIMIT)
        .then((opts) => {
          if (!cancelled && reqSeq === guideReqSeqRef.current) {
            setGuideOptions(opts);
          }
        })
        .catch(() => undefined);
    };
    if (guideQuery.length === 0) {
      run();
      return () => {
        cancelled = true;
      };
    }
    const timer = setTimeout(run, SEARCH_DEBOUNCE_MS);
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

  const effectiveMatchedKeys = useMemo(() => {
    if (remoteMatchedKeys.size === 0) return matchedKeys;
    const merged = new Set(matchedKeys);
    for (const key of remoteMatchedKeys) merged.add(key);
    return merged;
  }, [matchedKeys, remoteMatchedKeys]);

  const combinedChannels = useMemo(() => {
    if (remoteChannels === null) return channels;
    const seen = new Set<string>();
    const out: ItemRow[] = [];
    for (const ch of remoteChannels) {
      if (seen.has(ch.key)) continue;
      seen.add(ch.key);
      out.push(ch);
    }
    for (const ch of channels) {
      if (seen.has(ch.key)) continue;
      seen.add(ch.key);
      out.push(ch);
    }
    return out;
  }, [channels, remoteChannels]);

  const filteredChannels = useMemo(
    () =>
      filterMapperChannels(
        combinedChannels,
        overridesByKey,
        effectiveMatchedKeys,
        filter,
        debouncedQuery,
      ),
    [combinedChannels, debouncedQuery, effectiveMatchedKeys, filter, overridesByKey],
  );

  const showLoadMore =
    hasMoreChannels && onLoadMore !== undefined && debouncedQuery.trim().length === 0;

  const focusRows = useMemo(
    () =>
      buildChannelMapperFocusRows({
        channels: filteredChannels,
        overridesByKey,
        editingChannelKey,
        guideOptions,
        hasMore: showLoadMore,
      }),
    [editingChannelKey, filteredChannels, guideOptions, overridesByKey, showLoadMore],
  );

  useEffect(() => {
    setFocusedRow((prevRow) => {
      const clampedRow = Math.min(prevRow, Math.max(0, focusRows.length - 1));
      const maxCol = Math.max(0, mapperRowSlotCount(focusRows[clampedRow]) - 1);
      setFocusedCol((prevCol) => Math.min(prevCol, maxCol));
      return clampedRow;
    });
  }, [focusRows]);

  useEffect(() => {
    if (!isTv || !tvActive || onScrollToY === undefined) return;
    const row = focusRows[focusedRow];
    if (!row || row.kind === 'filters' || row.kind === 'search') {
      onScrollToY(0);
      return;
    }
    if (row.kind === 'load-more') {
      onScrollToY(loadMoreYRef.current > 0 ? loadMoreYRef.current : focusedRow * 88);
      return;
    }
    const cardY = rowYRef.current[row.channelKey];
    onScrollToY(cardY !== undefined ? listYRef.current + cardY : focusedRow * 88);
  }, [focusRows, focusedRow, isTv, onScrollToY, tvActive]);

  const openEditor = useCallback(
    (ch: ItemRow) => {
      const existing = overridesByKey.get(ch.key);
      setEditingChannelKey(ch.key);
      setSelectedGuideId(existing?.guideId ?? null);
      setSelectedGuideSourceId(existing?.guideSourceId ?? null);
      setOffsetHours(offsetMsToHours(existing?.epgShiftMs));
      setGuideQuery('');
    },
    [overridesByKey],
  );

  const closeEditor = useCallback(() => {
    guideReqSeqRef.current += 1;
    setEditingChannelKey(null);
    setSelectedGuideId(null);
    setSelectedGuideSourceId(null);
    setGuideQuery('');
  }, []);

  const handleSaveOverride = useCallback(
    async (channelKey: string) => {
      if (!catalog.setChannelGuideOverride || busy) return;
      const matchedOpt = guideOptions.find((opt) => opt.guideId === selectedGuideId);
      const resolvedGuideSourceId =
        matchedOpt !== undefined ? (matchedOpt.guideSourceId ?? null) : selectedGuideSourceId;
      onBusyChange(true);
      try {
        const res = await catalog.setChannelGuideOverride({
          sourceId,
          channelKey,
          guideSourceId: resolvedGuideSourceId,
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
      guideOptions,
      offsetHours,
      onBusyChange,
      onMutated,
      onRefresh,
      selectedGuideId,
      selectedGuideSourceId,
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

  const handleTvKey = useCallback(
    (key: KeyInput['key']): boolean => {
      if (key === 'back') {
        if (editingChannelKey !== null) {
          closeEditor();
          return true;
        }
        return false;
      }
      if (key === 'up') {
        if (focusedRow === 0) {
          onEdgeTop?.();
          return true;
        }
        const nextRow = focusedRow - 1;
        const maxCol = Math.max(0, mapperRowSlotCount(focusRows[nextRow]) - 1);
        setFocusedRow(nextRow);
        setFocusedCol((c) => Math.min(c, maxCol));
        return true;
      }
      if (key === 'down') {
        const nextRow = Math.min(Math.max(0, focusRows.length - 1), focusedRow + 1);
        const maxCol = Math.max(0, mapperRowSlotCount(focusRows[nextRow]) - 1);
        setFocusedRow(nextRow);
        setFocusedCol((c) => Math.min(c, maxCol));
        return true;
      }
      if (key === 'left') {
        setFocusedCol((c) => Math.max(0, c - 1));
        return true;
      }
      if (key === 'right') {
        const maxCol = Math.max(0, mapperRowSlotCount(focusRows[focusedRow]) - 1);
        setFocusedCol((c) => Math.min(maxCol, c + 1));
        return true;
      }
      if (key === 'select') {
        const row = focusRows[focusedRow];
        if (!row) return true;
        if (row.kind === 'filters') {
          const slot = row.slots[focusedCol];
          if (slot === 'filter-all') setFilter('all');
          else if (slot === 'filter-unmatched') setFilter('unmatched');
          return true;
        }
        if (row.kind === 'search') {
          searchInputRef.current?.focus();
          return true;
        }
        if (row.kind === 'load-more') {
          if (!loadingMore && onLoadMore !== undefined) void onLoadMore();
          return true;
        }
        if (row.kind === 'channel') {
          const slot = row.slots[focusedCol];
          const ch = filteredChannels.find((c) => c.key === row.channelKey);
          if (slot === 'assign' && ch !== undefined) openEditor(ch);
          else if (slot === 'clear') void handleClearOverride(row.channelKey);
          return true;
        }
        if (row.kind === 'editor-search') {
          guideSearchInputRef.current?.focus();
          return true;
        }
        if (row.kind === 'editor-options') {
          const opt = row.options[focusedCol];
          if (opt !== undefined) {
            setSelectedGuideId(opt.guideId);
            setSelectedGuideSourceId(opt.guideSourceId ?? null);
          }
          return true;
        }
        if (row.kind === 'editor-offset') {
          const slot = row.slots[focusedCol];
          if (slot === 'editor-offset-dec') setOffsetHours((h) => clampOffsetHours(h - 1));
          else if (slot === 'editor-offset-inc') setOffsetHours((h) => clampOffsetHours(h + 1));
          return true;
        }
        if (row.kind === 'editor-actions') {
          const slot = row.slots[focusedCol];
          if (slot === 'editor-save') void handleSaveOverride(row.channelKey);
          else if (slot === 'editor-clear') void handleClearOverride(row.channelKey);
          else if (slot === 'editor-cancel') closeEditor();
          return true;
        }
      }
      return false;
    },
    [
      closeEditor,
      editingChannelKey,
      filteredChannels,
      focusRows,
      focusedCol,
      focusedRow,
      handleClearOverride,
      handleSaveOverride,
      loadingMore,
      onEdgeTop,
      onLoadMore,
      openEditor,
    ],
  );

  useEffect(() => {
    if (!tvKeyHandlerRef) return;
    tvKeyHandlerRef.current = handleTvKey;
    return () => {
      if (tvKeyHandlerRef.current === handleTvKey) tvKeyHandlerRef.current = null;
    };
  }, [handleTvKey, tvKeyHandlerRef]);

  const activeFocusRow = isTv && tvActive ? focusRows[focusedRow] : undefined;
  const focusedGuideOptionId =
    activeFocusRow?.kind === 'editor-options'
      ? (activeFocusRow.options[focusedCol]?.guideId ?? null)
      : null;

  return (
    <View testID="channel-mapper-tab" style={styles.container}>
      <View style={styles.controlsRow}>
        <FilterChip
          testID="mapper-filter-all"
          label={i18n.t('sources.guides.filterAll')}
          selected={filter === 'all'}
          focusable={!isTv}
          focused={
            activeFocusRow?.kind === 'filters' && activeFocusRow.slots[focusedCol] === 'filter-all'
          }
          onPress={() => setFilter('all')}
        />
        <FilterChip
          testID="mapper-filter-unmatched"
          label={i18n.t('sources.guides.filterUnmatched')}
          selected={filter === 'unmatched'}
          focusable={!isTv}
          focused={
            activeFocusRow?.kind === 'filters' &&
            activeFocusRow.slots[focusedCol] === 'filter-unmatched'
          }
          onPress={() => setFilter('unmatched')}
        />
      </View>

      <TvTextInput
        ref={searchInputRef}
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
            borderColor:
              activeFocusRow?.kind === 'search'
                ? theme.colors.focusRingColor
                : theme.colors.surfaceBorder,
            borderWidth: activeFocusRow?.kind === 'search' ? theme.focus.ringWidth : 1,
            borderRadius: theme.radius.button,
          },
        ]}
      />

      <View
        style={styles.list}
        onLayout={(e) => {
          listYRef.current = e.nativeEvent.layout.y;
        }}
      >
        {filteredChannels.map((ch) => {
          const override = overridesByKey.get(ch.key);
          const status = resolveChannelMappingStatus(ch.key, overridesByKey, effectiveMatchedKeys);
          const isEditing = editingChannelKey === ch.key;
          const chOffsetHours = offsetMsToHours(override?.epgShiftMs);
          const isChannelRowFocused =
            activeFocusRow !== undefined &&
            'channelKey' in activeFocusRow &&
            activeFocusRow.channelKey === ch.key;

          return (
            <Surface
              key={ch.key}
              testID={`mapper-channel-row-${ch.key}`}
              tone="card"
              bordered
              rounded="card"
              style={styles.channelRow}
              onLayout={(e) => {
                rowYRef.current[ch.key] = e.nativeEvent.layout.y;
              }}
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
                <ChannelMapperEditor
                  channelKey={ch.key}
                  hasExistingOverride={override !== undefined}
                  guideQuery={guideQuery}
                  onChangeGuideQuery={setGuideQuery}
                  guideOptions={guideOptions}
                  selectedGuideId={selectedGuideId}
                  onSelectGuideOption={(opt) => {
                    setSelectedGuideId(opt.guideId);
                    setSelectedGuideSourceId(opt.guideSourceId ?? null);
                  }}
                  offsetHours={offsetHours}
                  onChangeOffsetHours={setOffsetHours}
                  guideSearchInputRef={guideSearchInputRef}
                  isTv={isTv}
                  isChannelRowFocused={isChannelRowFocused}
                  activeFocusRow={activeFocusRow}
                  focusedCol={focusedCol}
                  focusedGuideOptionId={focusedGuideOptionId}
                  busy={busy}
                  onSave={() => void handleSaveOverride(ch.key)}
                  onClear={() => void handleClearOverride(ch.key)}
                  onCancel={closeEditor}
                />
              ) : (
                <View style={styles.rowActions}>
                  <CtaButton
                    testID={`mapper-assign-${ch.key}`}
                    variant="secondary"
                    label={i18n.t('sources.guides.assignGuide')}
                    disabled={busy}
                    focusable={!isTv}
                    focused={
                      isChannelRowFocused &&
                      activeFocusRow.kind === 'channel' &&
                      activeFocusRow.slots[focusedCol] === 'assign'
                    }
                    onPress={() => openEditor(ch)}
                  />
                  {override !== undefined ? (
                    <CtaButton
                      testID={`mapper-clear-${ch.key}`}
                      variant="secondary"
                      label={i18n.t('sources.guides.clearOverride')}
                      disabled={busy}
                      focusable={!isTv}
                      focused={
                        isChannelRowFocused &&
                        activeFocusRow.kind === 'channel' &&
                        activeFocusRow.slots[focusedCol] === 'clear'
                      }
                      onPress={() => void handleClearOverride(ch.key)}
                    />
                  ) : null}
                </View>
              )}
            </Surface>
          );
        })}
      </View>

      {showLoadMore ? (
        <View
          style={styles.rowActions}
          onLayout={(e) => {
            loadMoreYRef.current = e.nativeEvent.layout.y;
          }}
        >
          <CtaButton
            testID="mapper-load-more"
            variant="secondary"
            label={i18n.t(loadingMore ? 'browse.loading' : 'catalog.seeAll')}
            disabled={busy || loadingMore}
            focusable={!isTv}
            focused={activeFocusRow?.kind === 'load-more'}
            onPress={() => void onLoadMore()}
          />
        </View>
      ) : null}
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
  rowActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
});
