import type { CatalogService, CategoryRow, ItemRow, SourceRow, WatchProgressRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  type ViewportOverride,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, render } from '@testing-library/react-native';
import {
  CatalogDiscoveryScreen,
  type CatalogDiscoveryScreenProps,
} from '../CatalogDiscoveryScreen';

export const KEYCODE_DPAD_UP = 19;
export const KEYCODE_DPAD_DOWN = 20;
export const KEYCODE_DPAD_LEFT = 21;
export const KEYCODE_DPAD_RIGHT = 22;
export const KEYCODE_DPAD_CENTER = 23;
export const KEYCODE_BACK = 4;

export function makeSource(id = 'src-1', name = 'Demo'): SourceRow {
  return { id, kind: 'xtream', name, createdAt: 1, needsImport: false };
}

export function makeCategory(index: number, overrides: Partial<CategoryRow> = {}): CategoryRow {
  const kind = overrides.kind ?? 'movie';
  return {
    id: `src-1|${kind}|cat-${index}`,
    sourceId: 'src-1',
    kind,
    name: `Category ${index}`,
    position: index,
    itemCount: 20,
    ...overrides,
  };
}

export function makeItem(
  catIndex: number,
  itemIndex: number,
  kind: 'movie' | 'series' = 'movie',
): ItemRow {
  const id = catIndex * 100_000 + itemIndex + 1;
  return {
    id,
    key: `${kind}:c${catIndex}:i${itemIndex}`,
    kind,
    sourceId: 'src-1',
    providerId: String(id),
    name: `${kind === 'series' ? 'Show' : 'Movie'} ${catIndex}-${itemIndex}`,
    logo: `https://art.example.test/${kind}-${catIndex}-${itemIndex}.jpg`,
    rating: 8.4,
    year: 2025,
    num: null,
  };
}

export function makeProgress(
  itemKey: string,
  overrides: Partial<WatchProgressRow> = {},
): WatchProgressRow {
  return {
    profileId: 'default',
    sourceId: 'src-1',
    itemKey,
    kind: 'movie',
    title: 'Title',
    subtitle: null,
    logo: null,
    seriesKey: null,
    season: null,
    episode: null,
    positionMs: 1_800_000,
    durationMs: 3_600_000,
    watched: false,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

interface MockCatalogOptions {
  readonly categories: readonly CategoryRow[];
  readonly itemsByCategory: ReadonlyMap<string, readonly ItemRow[]>;
  readonly progressByKey?: ReadonlyMap<string, WatchProgressRow>;
  readonly continueWatching?: readonly WatchProgressRow[];
  readonly dynamicCategory?: {
    readonly id: string;
    readonly count: number;
    readonly kind: 'movie' | 'series';
  };
}

export function createMockCatalog(opts: MockCatalogOptions) {
  const itemsCalls: Array<{ categoryId: string; offset: number; limit: number }> = [];
  const progressCalls: Array<readonly string[]> = [];

  const catalog = {
    categories: jest.fn(async (sourceId: string, kind: string) =>
      opts.categories.filter((c) => c.sourceId === sourceId && c.kind === kind),
    ),
    items: jest.fn(async (categoryId: string, offset: number, limit: number) => {
      itemsCalls.push({ categoryId, offset, limit });
      if (opts.dynamicCategory && opts.dynamicCategory.id === categoryId) {
        const end = Math.min(opts.dynamicCategory.count, offset + limit);
        const rows: ItemRow[] = [];
        for (let i = offset; i < end; i++) {
          rows.push(makeItem(0, i, opts.dynamicCategory.kind));
        }
        return rows;
      }
      const list = opts.itemsByCategory.get(categoryId) ?? [];
      return list.slice(offset, offset + limit);
    }),
    listContinueWatching: jest.fn(async (limit = 20) =>
      (opts.continueWatching ?? []).slice(0, limit),
    ),
    listProgressByKeys: jest.fn(async (keys: readonly string[]) => {
      progressCalls.push([...keys]);
      const out: WatchProgressRow[] = [];
      for (const k of keys) {
        const row = opts.progressByKey?.get(k);
        if (row) out.push(row);
      }
      return out;
    }),
  } as unknown as CatalogService;

  return { catalog, itemsCalls, progressCalls };
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

export function renderCatalog(
  props: Partial<CatalogDiscoveryScreenProps> & {
    catalog: CatalogService;
    sources: readonly SourceRow[];
  },
  opts: {
    viewport?: ViewportOverride;
    preset?: 'obsidianCrimson' | 'highContrast';
    androidSource?: AndroidKeySource;
  } = {},
) {
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
        <I18nProvider i18n={createAppI18n('en')}>
          <CatalogDiscoveryScreen
            kind={props.kind ?? 'movie'}
            catalog={props.catalog}
            sources={props.sources}
            refreshToken={props.refreshToken ?? 1}
            onOpenDetail={props.onOpenDetail ?? jest.fn()}
            onOpenSources={props.onOpenSources ?? jest.fn()}
            {...(props.onPlay !== undefined ? { onPlay: props.onPlay } : {})}
            {...(props.userStateVersion !== undefined
              ? { userStateVersion: props.userStateVersion }
              : {})}
            {...(props.memory !== undefined ? { memory: props.memory } : {})}
            {...(props.onMemoryChange !== undefined
              ? { onMemoryChange: props.onMemoryChange }
              : {})}
            {...(props.onFocusTopNav !== undefined ? { onFocusTopNav: props.onFocusTopNav } : {})}
            {...(props.isActiveScope !== undefined ? { isActiveScope: props.isActiveScope } : {})}
            {...(props.showElvPicks !== undefined ? { showElvPicks: props.showElvPicks } : {})}
          />
        </I18nProvider>
      </ThemeProvider>
    </ViewportProvider>
  );

  if (opts.androidSource) {
    return render(<RemoteKeysProvider android={opts.androidSource}>{content}</RemoteKeysProvider>);
  }
  return render(content);
}
