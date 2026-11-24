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
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChannelMapperTab } from './ChannelMapperTab';
import { GuideSourcesTab } from './GuideSourcesTab';
import type { GuideManageTab } from './guide-management-model';

const MAX_MAPPER_CHANNELS = 200;
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

async function fetchSourceLiveChannels(
  catalog: CatalogService,
  sourceId: string,
): Promise<ItemRow[]> {
  if (catalog.allSourcesItems !== undefined) {
    return catalog
      .allSourcesItems('live', 0, MAX_MAPPER_CHANNELS, [sourceId])
      .catch(() => [] as ItemRow[]);
  }
  const cats = await catalog.categories(sourceId, 'live').catch(() => []);
  const collected: ItemRow[] = [];
  const seen = new Set<string>();
  for (const cat of cats) {
    const rows = await catalog.items(cat.id, 0, MAX_MAPPER_CHANNELS).catch(() => [] as ItemRow[]);
    for (const row of rows) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      collected.push(row);
      if (collected.length >= MAX_MAPPER_CHANNELS) return collected;
    }
  }
  return collected;
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
  const isTv = viewport.formFactor === 'tv';

  const [tab, setTab] = useState<GuideManageTab>(initialTab);
  const [headerCol, setHeaderCol] = useState(0);
  const [guides, setGuides] = useState<readonly GuideSourceRecord[]>([]);
  const [channels, setChannels] = useState<readonly ItemRow[]>([]);
  const [overrides, setOverrides] = useState<readonly ChannelGuideOverrideRecord[]>([]);
  const [matchedKeys, setMatchedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  const loadAll = useCallback(async () => {
    if (source === null) return;
    const [loadedGuides, loadedOverrides, loadedChannels] = await Promise.all([
      catalog.listGuideSources
        ? catalog.listGuideSources(source.id).catch(() => [])
        : Promise.resolve([]),
      catalog.listChannelGuideOverrides
        ? catalog.listChannelGuideOverrides(source.id).catch(() => [])
        : Promise.resolve([]),
      fetchSourceLiveChannels(catalog, source.id),
    ]);
    const matched = await detectMatchedChannelKeys(catalog, loadedChannels);
    setGuides(loadedGuides);
    setOverrides(loadedOverrides);
    setChannels(loadedChannels);
    setMatchedKeys(matched);
  }, [catalog, source]);

  useEffect(() => {
    if (!visible || source === null) return;
    setTab(initialTab);
    setHeaderCol(initialTab === 'mapper' ? 1 : 0);
    void loadAll();
  }, [initialTab, loadAll, source, visible]);

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

  const handleTvNavigate = useCallback(
    (key: KeyInput['key']) => {
      if (key === 'left') {
        setHeaderCol((c) => Math.max(0, c - 1));
      } else if (key === 'right') {
        setHeaderCol((c) => Math.min(HEADER_CONTROLS.length - 1, c + 1));
      } else if (key === 'select') {
        const ctrl = HEADER_CONTROLS[headerCol];
        if (ctrl === 'tab-guides') setTab('guides');
        else if (ctrl === 'tab-mapper') setTab('mapper');
        else onClose();
      }
    },
    [headerCol, onClose],
  );

  if (!visible || source === null) return null;

  const focusedHeaderCtrl = isTv ? HEADER_CONTROLS[headerCol] : null;

  return (
    <View testID="guide-management-overlay" style={styles.root}>
      {isTv ? <GuideOverlayTvKeyTrap onBack={onClose} onNavigate={handleTvNavigate} /> : null}
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
              isTv={isTv}
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
 * Never uses React Native `<Modal>`; integrates `TextEntryBoundary` and `useTvKeyInterceptor`.
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
