import type { CatalogService, EpisodeRow, ItemRow, SourceRow } from '@elv/data';
import type { DownloadRecord } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import type { AppI18n } from '@elv/i18n';
import {
  EditorialCategoryBar,
  type EditorialCategoryItem,
  Icon,
  IconButton,
  type IconName,
  MicroPill,
  useKeyInterpreter,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PlayableEntry } from '../ports/play-target';
import { useDownloads } from '../shared';

const MAX_LIVE_ITEMS = 80;
const MAX_MOVIE_ITEMS = 100;
const MAX_SERIES_ITEMS = 80;
const MAX_SERIES_EPISODES = 120;

type PickerTab = 'live' | 'movie' | 'series' | 'downloads';

const PICKER_TAB_ORDER: readonly PickerTab[] = ['live', 'movie', 'series', 'downloads'];

/** Props of {@link MultiViewChannelPicker}. */
export interface MultiViewChannelPickerProps {
  readonly visible: boolean;
  readonly title: string;
  readonly catalog: Pick<CatalogService, 'categories' | 'items' | 'allSourcesItems'> &
    Partial<Pick<CatalogService, 'seasons' | 'episodes' | 'itemDetail'>>;
  readonly sources: readonly SourceRow[];
  readonly excludeItemKeys: ReadonlySet<string>;
  readonly isTv: boolean;
  readonly i18n: AppI18n;
  readonly onSelect: (entry: PlayableEntry) => void;
  readonly onClose: () => void;
}

interface PickerListRow {
  readonly key: string;
  readonly label: string;
  readonly sourceId: string;
  readonly icon: IconName;
  readonly isOffline?: boolean;
  readonly hasDrilldown?: boolean;
  readonly onChoose: () => void;
}

function formatEpisodeTitle(seriesName: string, ep: EpisodeRow): string {
  const epNum = ep.episode ?? 0;
  const code = epNum > 0 ? `S${ep.season}E${epNum}` : `S${ep.season}`;
  const epTitle = ep.title?.trim();
  return epTitle ? `${seriesName} · ${code} ${epTitle}` : `${seriesName} · ${code}`;
}

function formatDownloadTitle(rec: DownloadRecord): string {
  if (rec.kind === 'episode' && rec.seriesTitle) {
    const code =
      rec.season != null && rec.episodeNum != null
        ? `S${rec.season}E${rec.episodeNum}`
        : rec.season != null
          ? `S${rec.season}`
          : rec.episodeNum != null
            ? `E${rec.episodeNum}`
            : '';
    return code ? `${rec.seriesTitle} · ${code} ${rec.title}` : `${rec.seriesTitle} · ${rec.title}`;
  }
  return rec.title;
}

function itemRowToEntry(row: ItemRow, tab: 'live' | 'movie'): PlayableEntry {
  return {
    itemKey: row.key,
    sourceId: row.sourceId,
    title: row.name,
    kind: tab === 'live' ? 'live' : 'vod',
    itemKind: tab === 'live' ? 'live' : 'movie',
    ...(row.logo !== null ? { logo: row.logo } : {}),
  };
}

function episodeRowToEntry(series: ItemRow, ep: EpisodeRow): PlayableEntry {
  return {
    itemKey: ep.key,
    sourceId: series.sourceId,
    title: formatEpisodeTitle(series.name, ep),
    kind: 'vod',
    itemKind: 'episode',
    seriesKey: series.key,
    season: ep.season,
    ...(ep.episode !== null ? { episode: ep.episode } : {}),
    ...(series.logo !== null ? { logo: series.logo } : {}),
  };
}

function downloadRecordToEntry(rec: DownloadRecord): PlayableEntry {
  return {
    itemKey: rec.itemKey,
    sourceId: rec.sourceId,
    title: formatDownloadTitle(rec),
    kind: 'vod',
    itemKind: rec.kind === 'episode' ? 'episode' : 'movie',
    isLocalOffline: true,
    localFileUri: rec.localUri,
    ...(rec.poster ? { logo: rec.poster } : {}),
    ...(rec.season != null ? { season: rec.season } : {}),
    ...(rec.episodeNum != null ? { episode: rec.episodeNum } : {}),
  };
}

async function loadCatalogItems(
  catalog: MultiViewChannelPickerProps['catalog'],
  sources: readonly SourceRow[],
  kind: 'live' | 'movie' | 'series',
  limit: number,
): Promise<readonly ItemRow[]> {
  if (catalog.allSourcesItems !== undefined) {
    return catalog.allSourcesItems(kind, 0, limit);
  }
  const collected: ItemRow[] = [];
  for (const source of sources) {
    const cats = await catalog.categories(source.id, kind);
    for (const cat of cats) {
      if (collected.length >= limit) break;
      const page = await catalog.items(cat.id, 0, limit - collected.length);
      collected.push(...page);
    }
    if (collected.length >= limit) break;
  }
  return collected;
}

async function loadSeriesEpisodes(
  catalog: MultiViewChannelPickerProps['catalog'],
  series: ItemRow,
): Promise<readonly EpisodeRow[]> {
  let seriesId = series.id;
  if ((!Number.isFinite(seriesId) || seriesId <= 0) && catalog.itemDetail !== undefined) {
    const detail = await catalog.itemDetail(series.key);
    if (detail !== null) seriesId = detail.id;
  }
  if (catalog.seasons === undefined || catalog.episodes === undefined) return [];
  const seasonsRes = await catalog.seasons(seriesId);
  if (!seasonsRes.ok || seasonsRes.value.length === 0) return [];
  const collected: EpisodeRow[] = [];
  for (const season of seasonsRes.value) {
    if (collected.length >= MAX_SERIES_EPISODES) break;
    const eps = await catalog.episodes(seriesId, season.season);
    for (const ep of eps) {
      collected.push(ep);
      if (collected.length >= MAX_SERIES_EPISODES) break;
    }
  }
  return collected;
}

/**
 * Inline Cinema Quietude cross-media picker overlay for Multi-View (`#34`, `#221`, `Wave P5`):
 * zero RN `<Modal>`, borderless editorial underline filter tabs (`Live TV | Movies | Series | Downloads`),
 * Series episode drill-down, dedicated offline Downloads filter (0 provider connections), and full
 * 2D TV D-pad & Web Escape navigation.
 */
export function MultiViewChannelPicker({
  visible,
  title,
  catalog,
  sources,
  excludeItemKeys,
  isTv,
  i18n,
  onSelect,
  onClose,
}: MultiViewChannelPickerProps): ReactElement | null {
  const theme = useTheme();
  const { completed: completedDownloads } = useDownloads();
  const [activeTab, setActiveTab] = useState<PickerTab>('live');
  const [rows, setRows] = useState<readonly ItemRow[]>([]);
  const [selectedSeries, setSelectedSeries] = useState<ItemRow | null>(null);
  const [episodes, setEpisodes] = useState<readonly EpisodeRow[]>([]);
  const [cursor, setCursor] = useState(0);
  const pointer = !isTv ? webCursorPointer() : undefined;

  const sourceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) map.set(s.id, s.name);
    return map;
  }, [sources]);

  useEffect(() => {
    if (!visible) {
      setSelectedSeries(null);
      setEpisodes([]);
      setCursor(0);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || activeTab === 'downloads') return;
    let active = true;
    const limit =
      activeTab === 'movie'
        ? MAX_MOVIE_ITEMS
        : activeTab === 'series'
          ? MAX_SERIES_ITEMS
          : MAX_LIVE_ITEMS;
    void loadCatalogItems(catalog, sources, activeTab, limit)
      .then((loaded) => {
        if (active) setRows(loaded);
      })
      .catch(() => {
        if (active) setRows([]);
      });
    return () => {
      active = false;
    };
  }, [activeTab, catalog, sources, visible]);

  useEffect(() => {
    if (!visible || activeTab !== 'series' || selectedSeries === null) {
      setEpisodes([]);
      return;
    }
    let active = true;
    void loadSeriesEpisodes(catalog, selectedSeries)
      .then((loaded) => {
        if (active) setEpisodes(loaded);
      })
      .catch(() => {
        if (active) setEpisodes([]);
      });
    return () => {
      active = false;
    };
  }, [activeTab, catalog, selectedSeries, visible]);

  const handleTabSelect = useCallback((id: string) => {
    if (id === 'live' || id === 'movie' || id === 'series' || id === 'downloads') {
      setActiveTab(id);
      setSelectedSeries(null);
      setEpisodes([]);
      setCursor(0);
    }
  }, []);

  const tabItems = useMemo<readonly EditorialCategoryItem[]>(
    () => [
      {
        id: 'live',
        label: i18n.t('multiview.picker.tabLive'),
        testID: 'multiview-picker-tab-live',
      },
      {
        id: 'movie',
        label: i18n.t('multiview.picker.tabMovies'),
        testID: 'multiview-picker-tab-movie',
      },
      {
        id: 'series',
        label: i18n.t('multiview.picker.tabSeries'),
        testID: 'multiview-picker-tab-series',
      },
      {
        id: 'downloads',
        label: i18n.t('multiview.picker.tabDownloads'),
        testID: 'multiview-picker-tab-downloads',
      },
    ],
    [i18n],
  );

  const listRows = useMemo<readonly PickerListRow[]>(() => {
    if (activeTab === 'downloads') {
      return completedDownloads
        .filter((rec) => !excludeItemKeys.has(rec.itemKey))
        .map((rec) => ({
          key: rec.itemKey,
          label: formatDownloadTitle(rec),
          sourceId: rec.sourceId,
          icon: rec.kind === 'episode' ? 'series' : 'film',
          isOffline: true,
          onChoose: () => onSelect(downloadRecordToEntry(rec)),
        }));
    }
    if (activeTab === 'series' && selectedSeries !== null) {
      return episodes
        .filter((ep) => !excludeItemKeys.has(ep.key))
        .map((ep) => ({
          key: ep.key,
          label: formatEpisodeTitle(selectedSeries.name, ep),
          sourceId: selectedSeries.sourceId,
          icon: 'series',
          onChoose: () => onSelect(episodeRowToEntry(selectedSeries, ep)),
        }));
    }
    if (activeTab === 'series') {
      return rows.map((row) => ({
        key: row.key,
        label: row.name,
        sourceId: row.sourceId,
        icon: 'series',
        hasDrilldown: true,
        onChoose: () => {
          setSelectedSeries(row);
          setCursor(0);
        },
      }));
    }
    const mediaTab = activeTab === 'movie' ? 'movie' : 'live';
    return rows
      .filter((row) => !excludeItemKeys.has(row.key))
      .map((row) => ({
        key: row.key,
        label: row.name,
        sourceId: row.sourceId,
        icon: mediaTab === 'movie' ? 'film' : 'tv',
        onChoose: () => onSelect(itemRowToEntry(row, mediaTab)),
      }));
  }, [activeTab, completedDownloads, episodes, excludeItemKeys, onSelect, rows, selectedSeries]);

  const clampedCursor = Math.max(0, Math.min(Math.max(0, listRows.length - 1), cursor));
  const listRowsRef = useRef(listRows);
  listRowsRef.current = listRows;
  const cursorRef = useRef(clampedCursor);
  cursorRef.current = clampedCursor;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const selectedSeriesRef = useRef(selectedSeries);
  selectedSeriesRef.current = selectedSeries;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!visible || (Platform.OS as string) !== 'web') return;
    const onKeyDown = (event: { key?: string; preventDefault?: () => void }) => {
      if (event.key === 'Escape') {
        event.preventDefault?.();
        if (selectedSeriesRef.current !== null) {
          setSelectedSeries(null);
          setCursor(0);
        } else {
          onCloseRef.current();
        }
      }
    };
    const win = globalThis as unknown as {
      addEventListener?: (type: string, fn: (e: unknown) => void) => void;
      removeEventListener?: (type: string, fn: (e: unknown) => void) => void;
    };
    win.addEventListener?.('keydown', onKeyDown as (e: unknown) => void);
    return () => {
      win.removeEventListener?.('keydown', onKeyDown as (e: unknown) => void);
    };
  }, [visible]);

  useKeyInterpreter((event: KeyEvent) => {
    if (!visible) return false;
    if (event.kind === 'press' && event.key === 'back') {
      if (selectedSeriesRef.current !== null) {
        setSelectedSeries(null);
        setCursor(0);
      } else {
        onCloseRef.current();
      }
      return true;
    }
    if (
      (event.kind === 'press' || event.kind === 'repeat') &&
      (event.key === 'left' || event.key === 'right') &&
      selectedSeriesRef.current === null
    ) {
      const idx = PICKER_TAB_ORDER.indexOf(activeTabRef.current);
      const nextIdx =
        event.key === 'right'
          ? Math.min(PICKER_TAB_ORDER.length - 1, idx + 1)
          : Math.max(0, idx - 1);
      const nextTab = PICKER_TAB_ORDER[nextIdx];
      if (nextTab !== undefined && nextTab !== activeTabRef.current) {
        handleTabSelect(nextTab);
      }
      return true;
    }
    if (
      (event.kind === 'press' || event.kind === 'repeat') &&
      (event.key === 'up' || event.key === 'down')
    ) {
      const len = listRowsRef.current.length;
      if (len > 0) {
        const delta = event.key === 'down' ? 1 : -1;
        setCursor((prev) => Math.max(0, Math.min(len - 1, prev + delta)));
      }
      return true;
    }
    if (event.kind === 'press' && event.key === 'select') {
      listRowsRef.current[cursorRef.current]?.onChoose();
      return true;
    }
    return true;
  });

  if (!visible) return null;

  const showSourceBadge = sources.length > 1;
  const emptyMessage =
    activeTab === 'downloads'
      ? i18n.t('multiview.picker.emptyDownloads')
      : activeTab === 'movie'
        ? i18n.t('multiview.picker.emptyMovies')
        : activeTab === 'series'
          ? i18n.t('multiview.picker.emptySeries')
          : i18n.t('live.emptyTitle');

  return (
    <View
      testID="multiview-channel-picker"
      style={[styles.backdrop, { backgroundColor: theme.colors.overlayBackdrop }]}
    >
      <View
        style={[
          styles.panel,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
          <Text
            numberOfLines={1}
            style={[theme.typography.h2, styles.flex1, { color: theme.colors.textPrimary }]}
          >
            {title}
          </Text>
          <IconButton
            testID="multiview-picker-close"
            icon="close"
            size={36}
            accessibilityLabel={i18n.t('player.close')}
            focusable={!isTv}
            onPress={onClose}
          />
        </View>

        <EditorialCategoryBar
          testID="multiview-picker-tabs"
          items={tabItems}
          activeId={activeTab}
          isTv={isTv}
          onSelect={handleTabSelect}
        />

        {activeTab === 'downloads' ? (
          <View
            testID="multiview-picker-downloads-hint"
            style={[
              styles.hintBanner,
              {
                backgroundColor: theme.colors.bgSurface,
                borderColor: theme.colors.surfaceBorder,
                borderRadius: theme.radius.button,
              },
            ]}
          >
            <Icon name="download" size={14} color={theme.colors.accent} />
            <Text
              style={[
                theme.typography.caption,
                styles.flex1,
                { color: theme.colors.textSecondary },
              ]}
            >
              {i18n.t('multiview.picker.downloadsHint')}
            </Text>
          </View>
        ) : null}

        {activeTab === 'series' && selectedSeries !== null ? (
          <Pressable
            testID="multiview-picker-series-back"
            accessibilityRole="button"
            accessibilityLabel={i18n.t('multiview.picker.tabSeries')}
            focusable={!isTv}
            onPress={() => {
              setSelectedSeries(null);
              setCursor(0);
            }}
            style={[
              styles.seriesBackRow,
              pointer,
              { borderBottomColor: theme.colors.surfaceBorder },
            ]}
          >
            <Icon name="back" size={16} color={theme.colors.accent} />
            <Text
              numberOfLines={1}
              style={[theme.typography.title, styles.flex1, { color: theme.colors.textPrimary }]}
            >
              {selectedSeries.name}
            </Text>
          </Pressable>
        ) : null}

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {listRows.map((row, idx) => {
            const focused = isTv && idx === clampedCursor;
            const srcName = sourceNameById.get(row.sourceId);
            return (
              <Pressable
                key={row.key}
                testID={`multiview-picker-item-${idx}`}
                accessibilityRole="button"
                accessibilityLabel={row.label}
                focusable={!isTv}
                onPress={row.onChoose}
                style={[
                  styles.row,
                  pointer,
                  {
                    backgroundColor: focused ? theme.colors.focusFill : 'transparent',
                    borderColor: focused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
                    borderWidth: focused ? theme.focus.ringWidth : 0,
                    borderBottomWidth: focused ? theme.focus.ringWidth : StyleSheet.hairlineWidth,
                    borderRadius: focused ? theme.radius.button : 0,
                  },
                ]}
              >
                <Icon name={row.icon} size={16} color={theme.colors.textSecondary} />
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.title,
                    styles.flex1,
                    { color: theme.colors.textPrimary },
                  ]}
                >
                  {row.label}
                </Text>
                {row.isOffline === true ? (
                  <MicroPill
                    testID={`multiview-picker-offline-badge-${idx}`}
                    label={i18n.t('downloads.offlineBadge')}
                    tone="neutral"
                  />
                ) : showSourceBadge && srcName !== undefined ? (
                  <MicroPill label={srcName} tone="neutral" />
                ) : null}
                {row.hasDrilldown === true ? (
                  <Icon name="chevronRight" size={16} color={theme.colors.textMuted} />
                ) : null}
              </Pressable>
            );
          })}
          {listRows.length === 0 ? (
            <Text
              testID="multiview-picker-empty"
              style={[theme.typography.caption, styles.empty, { color: theme.colors.textMuted }]}
            >
              {emptyMessage}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    zIndex: 60,
  },
  panel: {
    width: '100%',
    maxWidth: 500,
    maxHeight: '82%',
    borderWidth: 1,
    padding: 16,
    gap: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  flex1: { flex: 1 },
  hintBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  seriesBackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  list: { maxHeight: 360 },
  listContent: { gap: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 42,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  empty: {
    paddingVertical: 16,
    textAlign: 'center',
  },
});
