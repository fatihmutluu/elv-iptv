import type {
  CatalogService,
  ChannelGuideOverrideRecord,
  GuideSourceRecord,
  ItemRow,
  SourceRow,
} from '@elv/data';
import type { KeyInput } from '@elv/focus-core';
import {
  CtaButton,
  FilterChip,
  TextEntryBoundary,
  TvFocusAnchor,
  useI18n,
  useTextEntrySuspension,
  useTheme,
  useTvKeyInterceptor,
  useTvKeySource,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useProfile } from '../shared';
import { ChannelMapperTab } from './ChannelMapperTab';
import { GuideSourcesTab } from './GuideSourcesTab';
import type { GuideManageTab } from './guide-management-model';

const MAPPER_PAGE_SIZE = 200;
const NOW_NEXT_CHUNK = 50;
const NOOP_TV_SUBSCRIBER = (): boolean => false;

/** Props of {@link GuideManagementOverlay}. */
export interface GuideManagementOverlayProps {
  readonly visible: boolean;
  readonly source: SourceRow | null;
  readonly catalog: CatalogService;
  readonly initialTab?: GuideManageTab;
  readonly onMutated?: () => void;
  readonly onClose: () => void;
}

function GuideOverlayTvKeyTrap({
  onBack,
  onNavigate,
}: {
  readonly onBack: () => void;
  readonly onNavigate: (key: KeyInput['key']) => void;
}): ReactElement {
  const textEntry = useTextEntrySuspension();
  const callbacksRef = useRef({ onBack, onNavigate });
  callbacksRef.current = { onBack, onNavigate };

  useTvKeySource(NOOP_TV_SUBSCRIBER);
  useTvKeyInterceptor((input) => {
    if (textEntry.isActive()) return false;
    if (input.action !== 'down' && input.action !== 'press') return true;
    if (input.key === 'back') {
      callbacksRef.current.onBack();
      return true;
    }
    callbacksRef.current.onNavigate(input.key);
    return true;
  });

  return <TvFocusAnchor testID="guide-manage-tv-focus-anchor" hasTVPreferredFocus />;
}

async function fetchSourceLiveChannelsPage(
  catalog: CatalogService,
  sourceId: string,
  offset: number,
  limit: number,
): Promise<{ readonly items: ItemRow[]; readonly hasMore: boolean }> {
  if (catalog.allSourcesItems !== undefined) {
    const rows = await catalog
      .allSourcesItems('live', offset, limit + 1, [sourceId])
      .catch(() => [] as ItemRow[]);
    return {
      items: rows.slice(0, limit),
      hasMore: rows.length > limit,
    };
  }
  const cats = await catalog.categories(sourceId, 'live').catch(() => []);
  const collected: ItemRow[] = [];
  const seen = new Set<string>();
  for (const cat of cats) {
    const rows = await catalog.items(cat.id, 0, offset + limit + 1).catch(() => [] as ItemRow[]);
    for (const row of rows) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      collected.push(row);
    }
  }
  return {
    items: collected.slice(offset, offset + limit),
    hasMore: collected.length > offset + limit,
  };
}

async function detectMatchedChannelKeys(
  catalog: CatalogService,
  channels: readonly ItemRow[],
): Promise<ReadonlySet<string>> {
  const matched = new Set<string>();
  if (!catalog.nowNext || channels.length === 0) return matched;
  const now = Date.now();
  for (let i = 0; i < channels.length; i += NOW_NEXT_CHUNK) {
    const chunk = channels.slice(i, i + NOW_NEXT_CHUNK).map((c) => c.key);
    const entries = await catalog.nowNext(chunk, now).catch(() => []);
    for (const entry of entries) {
      if (entry.now !== null || entry.next !== null) {
        matched.add(entry.channelKey);
      }
    }
  }
  return matched;
}

const HEADER_CONTROLS = ['tab-guides', 'tab-mapper', 'close'] as const;

function GuideManagementOverlayBody({
  visible,
  source,
  catalog,
  initialTab = 'guides',
  onMutated,
  onClose,
}: GuideManagementOverlayProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const profile = useProfile();
  const parentalLocked = profile.hasGuardPin && !profile.parentalUnlocked;
  const isTv = viewport.formFactor === 'tv';

  const [tab, setTab] = useState<GuideManageTab>(initialTab);
  const [tvZone, setTvZone] = useState<'header' | 'body'>('header');
  const [headerCol, setHeaderCol] = useState(0);
  const [guides, setGuides] = useState<readonly GuideSourceRecord[]>([]);
  const [channels, setChannels] = useState<readonly ItemRow[]>([]);
  const [hasMoreChannels, setHasMoreChannels] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [overrides, setOverrides] = useState<readonly ChannelGuideOverrideRecord[]>([]);
  const [matchedKeys, setMatchedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  const scrollViewRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const tabTvHandlerRef = useRef<((key: KeyInput['key']) => boolean) | null>(null);
  const loadSeqRef = useRef(0);
  const channelsLengthRef = useRef(0);
  channelsLengthRef.current = channels.length;

  useEffect(() => {
    if (visible && parentalLocked) {
      onClose();
    }
  }, [onClose, parentalLocked, visible]);

  const loadAll = useCallback(async () => {
    if (source === null) return;
    const seq = ++loadSeqRef.current;
    const [loadedGuides, loadedOverrides, firstPage] = await Promise.all([
      catalog.listGuideSources
        ? catalog.listGuideSources(source.id).catch(() => [])
        : Promise.resolve([]),
      catalog.listChannelGuideOverrides
        ? catalog.listChannelGuideOverrides(source.id).catch(() => [])
        : Promise.resolve([]),
      fetchSourceLiveChannelsPage(catalog, source.id, 0, MAPPER_PAGE_SIZE),
    ]);
    if (seq !== loadSeqRef.current) return;
    const matched = await detectMatchedChannelKeys(catalog, firstPage.items);
    if (seq !== loadSeqRef.current) return;
    setGuides(loadedGuides);
    setOverrides(loadedOverrides);
    setChannels(firstPage.items);
    setHasMoreChannels(firstPage.hasMore);
    setMatchedKeys(matched);
  }, [catalog, source]);

  const loadMoreChannels = useCallback(async () => {
    if (source === null || loadingMore || !hasMoreChannels) return;
    const seq = loadSeqRef.current;
    setLoadingMore(true);
    try {
      const nextPage = await fetchSourceLiveChannelsPage(
        catalog,
        source.id,
        channelsLengthRef.current,
        MAPPER_PAGE_SIZE,
      );
      if (seq !== loadSeqRef.current) return;
      const newMatched = await detectMatchedChannelKeys(catalog, nextPage.items);
      if (seq !== loadSeqRef.current) return;
      setChannels((prev) => {
        const seen = new Set(prev.map((c) => c.key));
        const merged = [...prev];
        for (const row of nextPage.items) {
          if (!seen.has(row.key)) {
            seen.add(row.key);
            merged.push(row);
          }
        }
        return merged;
      });
      setHasMoreChannels(nextPage.hasMore);
      if (newMatched.size > 0) {
        setMatchedKeys((prev) => {
          const next = new Set(prev);
          for (const key of newMatched) next.add(key);
          return next;
        });
      }
    } finally {
      if (seq === loadSeqRef.current) setLoadingMore(false);
    }
  }, [catalog, hasMoreChannels, loadingMore, source]);

  useEffect(() => {
    if (!visible || source === null) {
      loadSeqRef.current += 1;
      return;
    }
    setTab(initialTab);
    setTvZone('header');
    setHeaderCol(initialTab === 'mapper' ? 1 : 0);
    setLoadingMore(false);
    void loadAll();
    return () => {
      loadSeqRef.current += 1;
    };
  }, [initialTab, loadAll, source, visible]);

  const scrollToY = useCallback(
    (y: number) => {
      scrollViewRef.current?.scrollTo({
        y: Math.max(0, y - 24),
        animated: !theme.reduceMotion,
      });
    },
    [theme.reduceMotion],
  );

  useEffect(() => {
    if (isTv && visible && tvZone === 'header') {
      scrollViewRef.current?.scrollTo({ y: 0, animated: !theme.reduceMotion });
    }
  }, [isTv, theme.reduceMotion, tvZone, visible]);

  useEffect(() => {
    if (!visible || (Platform.OS as string) !== 'web') return;
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
    };
    const onKeyDown = (e: { key?: string; preventDefault?: () => void }) => {
      if (e.key === 'Escape') {
        e.preventDefault?.();
        onClose();
      }
    };
    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [onClose, visible]);

  const handleTvBack = useCallback(() => {
    if (tvZone === 'body' && tabTvHandlerRef.current?.('back')) {
      return;
    }
    onClose();
  }, [onClose, tvZone]);

  const handleTvNavigate = useCallback(
    (key: KeyInput['key']) => {
      if (tvZone === 'header') {
        if (key === 'left') {
          setHeaderCol((c) => Math.max(0, c - 1));
        } else if (key === 'right') {
          setHeaderCol((c) => Math.min(HEADER_CONTROLS.length - 1, c + 1));
        } else if (key === 'down') {
          setTvZone('body');
        } else if (key === 'select') {
          const ctrl = HEADER_CONTROLS[headerCol];
          if (ctrl === 'tab-guides') setTab('guides');
          else if (ctrl === 'tab-mapper') setTab('mapper');
          else onClose();
        }
        return;
      }
      tabTvHandlerRef.current?.(key);
    },
    [headerCol, onClose, tvZone],
  );

  if (!visible || source === null || parentalLocked) return null;

  const focusedHeaderCtrl = isTv && tvZone === 'header' ? HEADER_CONTROLS[headerCol] : null;

  return (
    <View testID="guide-management-overlay" style={styles.root}>
      {isTv ? <GuideOverlayTvKeyTrap onBack={handleTvBack} onNavigate={handleTvNavigate} /> : null}
      <Pressable
        testID="guide-manage-backdrop"
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={i18n.t('ui.dismiss')}
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlayBackdrop }]}
      />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
          <View style={styles.headerTitles}>
            <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
              {`${i18n.t('sources.guides.title')} · ${source.name}`}
            </Text>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('sources.guides.subtitle')}
            </Text>
          </View>
          <CtaButton
            testID="guide-manage-close-btn"
            label={i18n.t('player.close')}
            variant="secondary"
            focusable={!isTv}
            focused={focusedHeaderCtrl === 'close'}
            onPress={onClose}
          />
        </View>

        <View style={styles.tabsRow}>
          <FilterChip
            testID="guide-manage-tab-guides"
            label={i18n.t('sources.guides.guidesTab')}
            selected={tab === 'guides'}
            focusable={!isTv}
            focused={focusedHeaderCtrl === 'tab-guides'}
            onPress={() => setTab('guides')}
          />
          <FilterChip
            testID="guide-manage-tab-mapper"
            label={i18n.t('sources.guides.mapperTab')}
            selected={tab === 'mapper'}
            focusable={!isTv}
            focused={focusedHeaderCtrl === 'tab-mapper'}
            onPress={() => setTab('mapper')}
          />
        </View>

        <ScrollView
          ref={scrollViewRef}
          testID="guide-manage-scroll"
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          {...(isTv ? { focusable: false } : {})}
        >
          {tab === 'guides' ? (
            <GuideSourcesTab
              sourceId={source.id}
              catalog={catalog}
              guides={guides}
              isTv={isTv}
              tvActive={tvZone === 'body'}
              tvKeyHandlerRef={tabTvHandlerRef}
              onEdgeTop={() => setTvZone('header')}
              onScrollToY={scrollToY}
              busy={busy}
              onBusyChange={setBusy}
              onRefresh={loadAll}
              {...(onMutated !== undefined ? { onMutated } : {})}
            />
          ) : (
            <ChannelMapperTab
              sourceId={source.id}
              catalog={catalog}
              channels={channels}
              overrides={overrides}
              matchedKeys={matchedKeys}
              hasMoreChannels={hasMoreChannels}
              loadingMore={loadingMore}
              onLoadMore={loadMoreChannels}
              isTv={isTv}
              tvActive={tvZone === 'body'}
              tvKeyHandlerRef={tabTvHandlerRef}
              onEdgeTop={() => setTvZone('header')}
              onScrollToY={scrollToY}
              busy={busy}
              onBusyChange={setBusy}
              onRefresh={loadAll}
              {...(onMutated !== undefined ? { onMutated } : {})}
            />
          )}
        </ScrollView>
      </View>
    </View>
  );
}

/**
 * Cinema Quietude v2 in-tree Multi-Guide Priority & Manual Channel Mapper overlay (`#30`).
 * Never uses React Native `<Modal>`; integrates `TextEntryBoundary`, 2D TV D-pad traversal,
 * and parental PIN enforcement.
 */
export function GuideManagementOverlay(props: GuideManagementOverlayProps): ReactElement | null {
  if (!props.visible || props.source === null) return null;
  return (
    <TextEntryBoundary>
      <GuideManagementOverlayBody {...props} />
    </TextEntryBoundary>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 55,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 820,
    maxHeight: '88%',
    borderWidth: 1,
    padding: 20,
    gap: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitles: { flex: 1, gap: 2 },
  tabsRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  scrollContent: { paddingBottom: 8 },
});
