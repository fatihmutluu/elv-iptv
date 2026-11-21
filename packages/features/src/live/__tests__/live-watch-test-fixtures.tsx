import type { CatalogService, CategoryRow, ItemRow, NowNextEntry, SourceRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  IconButton,
  RemoteKeysProvider,
  ThemeProvider,
  useI18n,
  useTheme,
  useViewport,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, render } from '@testing-library/react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { computeCatalogLayout } from '../../shared';
import { LiveChannelsGrid } from '../LiveChannelsGrid';
import { LiveCategoryBar, LiveModeSwitcher, LiveNumberPad } from '../LiveChrome';
import { LiveWatchStage } from '../LiveWatchStage';
import type { LiveMode } from '../live-model';
import { useLiveCatalog } from '../useLiveCatalog';

const NOW_MS = 1_700_000_000_000;

export function makeSource(id = 'src-1', name = 'Demo Live'): SourceRow {
  return { id, kind: 'xtream', name, createdAt: 1, needsImport: false };
}

export function makeLiveCategory(index: number, overrides: Partial<CategoryRow> = {}): CategoryRow {
  return {
    id: `src-1|live|cat-${index}`,
    sourceId: 'src-1',
    kind: 'live',
    name: index === 0 ? 'News' : `Sports ${index}`,
    position: index,
    itemCount: 20,
    ...overrides,
  };
}

function makeLiveChannel(index: number, overrides: Partial<ItemRow> = {}): ItemRow {
  const num = 101 + index;
  return {
    id: index + 1,
    key: `live:src-1:ch-${index}`,
    kind: 'live',
    sourceId: 'src-1',
    providerId: String(num),
    name: `Channel ${num}`,
    logo: `https://art.example.test/ch-${num}.png`,
    rating: null,
    year: null,
    num,
    ...overrides,
  };
}

function makeNowNext(channelKey: string, num: number): NowNextEntry {
  return {
    channelKey,
    now: {
      channelKey,
      sourceId: 'src-1',
      guideId: `g-${num}`,
      start: NOW_MS - 30 * 60_000,
      stop: NOW_MS + 30 * 60_000,
      title: `Evening News ${num}`,
      subTitle: null,
      description: null,
      episodeNum: null,
      icon: null,
    },
    next: {
      channelKey,
      sourceId: 'src-1',
      guideId: `g-${num}`,
      start: NOW_MS + 30 * 60_000,
      stop: NOW_MS + 90 * 60_000,
      title: `Late Report ${num}`,
      subTitle: null,
      description: null,
      episodeNum: null,
      icon: null,
    },
  };
}

export function createAndroidSource() {
  let listener: ((event: AndroidKeyEvent) => void) | null = null;
  const source: AndroidKeySource = {
    addListener(cb) {
      listener = cb;
      return {
        remove() {
          listener = null;
        },
      };
    },
  };
  const sendKey = async (keyCode: number) => {
    await act(async () => {
      listener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
      listener?.({ keyCode, action: 'up', canceled: false, ageMs: 10 });
    });
  };
  return { source, sendKey };
}

export function createLiveMockCatalog(opts: {
  readonly categories: readonly CategoryRow[];
  readonly totalChannels: number;
  readonly channelByNumMap?: ReadonlyMap<number, ItemRow>;
}) {
  const itemsCalls: Array<{ categoryId: string; offset: number; limit: number }> = [];
  const nowNextCalls: Array<readonly string[]> = [];
  const channelByNumberCalls: Array<{ num: number; sourceId: string | undefined }> = [];

  const catalog = {
    categories: jest.fn(async (sourceId: string, kind: string) =>
      opts.categories.filter((c) => c.sourceId === sourceId && c.kind === kind),
    ),
    items: jest.fn(async (categoryId: string, offset: number, limit: number) => {
      itemsCalls.push({ categoryId, offset, limit });
      const end = Math.min(opts.totalChannels, offset + limit);
      const rows: ItemRow[] = [];
      for (let i = offset; i < end; i++) {
        rows.push(makeLiveChannel(i));
      }
      return rows;
    }),
    nowNext: jest.fn(async (channelKeys: readonly string[]) => {
      nowNextCalls.push([...channelKeys]);
      return channelKeys.map((key) => {
        const match = /ch-(\d+)$/.exec(key);
        const idx = match ? Number.parseInt(match[1] ?? '0', 10) : 0;
        return makeNowNext(key, 101 + idx);
      });
    }),
    channelByNumber: jest.fn(async (num: number, sourceId?: string) => {
      channelByNumberCalls.push({ num, sourceId });
      if (opts.channelByNumMap?.has(num)) return opts.channelByNumMap.get(num) ?? null;
      const idx = num - 101;
      if (idx >= 0 && idx < opts.totalChannels) return makeLiveChannel(idx);
      return null;
    }),
    itemDetail: jest.fn(async (itemKey: string) => {
      const match = /ch-(\d+)$/.exec(itemKey);
      if (!match) return null;
      const idx = Number.parseInt(match[1] ?? '0', 10);
      return { ...makeLiveChannel(idx), plot: null };
    }),
  } as unknown as CatalogService;

  return { catalog, itemsCalls, nowNextCalls, channelByNumberCalls };
}

export interface HarnessProps {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  readonly initialMode: LiveMode;
  readonly activeChannelKey?: string | null;
  readonly previousChannelKey?: string | null;
  readonly focusedZapIndex?: number | null;
  readonly onWatchChannel: (channel: ItemRow, index: number) => void;
  readonly onEdgeTop?: () => void;
}

export function LiveHubHarness({
  catalog,
  sources,
  initialMode,
  activeChannelKey = null,
  previousChannelKey = null,
  focusedZapIndex = null,
  onWatchChannel,
  onEdgeTop,
}: HarnessProps) {
  const theme = useTheme();
  const viewport = useViewport();
  const i18n = useI18n();
  const layout = computeCatalogLayout(viewport, theme);
  const [mode, setMode] = useState<LiveMode>(initialMode);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [zapDrawerOpen, setZapDrawerOpen] = useState(true);
  const [numpadOpen, setNumpadOpen] = useState(false);

  const live = useLiveCatalog({
    catalog,
    sources,
    mode,
    selectedCategoryId,
    activeChannelKey,
    previousChannelKey,
    onSelectCategoryId: setSelectedCategoryId,
    now: () => NOW_MS,
  });

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <LiveModeSwitcher
          mode={mode}
          onSelectMode={setMode}
          isTv={layout.isTv}
          isTouch={layout.isTouch}
        />
        {mode === 'channels' ? (
          <IconButton
            testID="live-channels-numpad-toggle"
            icon="keypad"
            accessibilityLabel={i18n.t('live.numberPad')}
            active={numpadOpen}
            focusable={!layout.isTv}
            onPress={() => setNumpadOpen((v) => !v)}
          />
        ) : null}
      </View>
      <LiveCategoryBar
        categories={live.categories}
        activeCategoryId={live.activeCategory?.row.id ?? null}
        channelCount={live.channelCount}
        layout={layout}
        onSelectCategory={setSelectedCategoryId}
      />
      {mode === 'channels' && numpadOpen ? (
        <LiveNumberPad
          visible
          buffer={live.numberBuffer}
          feedback={live.numberFeedback}
          isTv={layout.isTv}
          isTouch={layout.isTouch}
          onDigit={live.pressDigit}
          onClear={live.clearNumber}
          onSubmit={() => {
            void live.submitNumberJump();
          }}
          onClose={() => setNumpadOpen(false)}
        />
      ) : null}
      {mode === 'channels' ? (
        <LiveChannelsGrid
          channelSource={live.channelSource}
          sourceVersion={live.sourceVersion}
          nowNextByKey={live.nowNextByKey}
          nowNextVersion={live.nowNextVersion}
          activeChannelKey={live.activeChannel?.key ?? null}
          favoriteKeys={live.favoriteKeys}
          layout={layout}
          hydrateNowNext={live.hydrateNowNext}
          onWatchChannel={onWatchChannel}
          onToggleFavorite={(ch) => {
            void live.toggleFavorite(ch);
          }}
          onEdgeTop={onEdgeTop}
          isActiveScope
          now={() => NOW_MS}
        />
      ) : (
        <LiveWatchStage
          activeChannel={live.activeChannel}
          activeChannelIndex={live.activeChannelIndex}
          channelSource={live.channelSource}
          sourceVersion={live.sourceVersion}
          nowNextByKey={live.nowNextByKey}
          nowNextVersion={live.nowNextVersion}
          zapDrawerOpen={zapDrawerOpen}
          layout={layout}
          hydrateNowNext={live.hydrateNowNext}
          onToggleZapDrawer={() => setZapDrawerOpen((v) => !v)}
          onBrowseChannels={() => setMode('channels')}
          onSelectChannel={(ch, idx) => {
            live.tuneChannel(ch, idx);
          }}
          onWatchFullscreen={onWatchChannel}
          focusedZapIndex={focusedZapIndex}
          now={() => NOW_MS}
        />
      )}
    </View>
  );
}

export function renderHarness(
  props: HarnessProps,
  opts: {
    viewport?: ViewportOverride;
    preset?: 'obsidianCrimson' | 'highContrast';
    androidSource?: AndroidKeySource;
  } = {},
) {
  const i18n = createAppI18n('en');
  const content = (
    <ViewportProvider
      value={
        opts.viewport ?? {
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }
      }
    >
      <ThemeProvider preset={opts.preset ?? 'obsidianCrimson'}>
        <I18nProvider i18n={i18n}>
          <LiveHubHarness {...props} />
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );

  return render(
    opts.androidSource ? (
      <RemoteKeysProvider android={opts.androidSource}>{content}</RemoteKeysProvider>
    ) : (
      content
    ),
  );
}
