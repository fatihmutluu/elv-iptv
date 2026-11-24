import type { CatalogService, CategoryRow, ItemRow, ProgrammeRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, type ViewportOverride, ViewportProvider } from '@elv/ui-kit';
import { render, waitFor } from '@testing-library/react-native';
import { createPagedListSource, type DisplayCategory } from '../../shared';
import { EpgGridView } from '../EpgGridView';
import { LIVE_MAX_PAGES, LIVE_PAGE_SIZE } from '../live-model';

const BASE_MS = Date.UTC(2026, 10, 21, 18, 0, 0);
const NOW_MS = BASE_MS + 15 * 60_000;

const DESKTOP_VIEWPORT: ViewportOverride = {
  formFactor: 'desktop',
  orientation: 'landscape',
  inputModality: 'pointer',
  width: 1280,
  height: 720,
};

function makeChannel(index: number): ItemRow {
  return {
    id: index + 1,
    key: `x:src-1:live:${index + 1}`,
    kind: 'live',
    sourceId: 'src-1',
    providerId: String(index + 1),
    name: `Channel ${index + 1}`,
    logo: null,
    rating: null,
    year: null,
    num: index + 1,
  };
}

function makeCategory(itemCount: number): DisplayCategory {
  const row: CategoryRow = {
    id: 'src-1|live|all',
    sourceId: 'src-1',
    kind: 'live',
    name: 'All Channels',
    position: 0,
    itemCount,
  };
  return { row, label: 'All Channels' };
}

describe('EpgGridView activeChannelKey auto-focus beyond page 0 (#6)', () => {
  it('resolves an active channel on an unloaded page (index >= 120) and hydrates visible rows on non-TV', async () => {
    const total = 300;
    const targetIndex = 150;
    const targetKey = `x:src-1:live:${targetIndex + 1}`;

    const channelSource = createPagedListSource<ItemRow>({
      count: total,
      pageSize: LIVE_PAGE_SIZE,
      maxPages: LIVE_MAX_PAGES,
      loadPage: async (offset, limit) => {
        const end = Math.min(total, offset + limit);
        const rows: ItemRow[] = [];
        for (let i = offset; i < end; i++) rows.push(makeChannel(i));
        return rows;
      },
    });

    const epgWindow = jest.fn(
      async (keys: readonly string[]): Promise<Record<string, ProgrammeRow[]>> => {
        const out: Record<string, ProgrammeRow[]> = {};
        for (const key of keys) {
          out[key] = [
            {
              channelKey: key,
              sourceId: 'src-1',
              guideId: `g-${key}`,
              start: BASE_MS,
              stop: BASE_MS + 60 * 60_000,
              title: `Show on ${key}`,
              subTitle: null,
              description: null,
              episodeNum: null,
              icon: null,
              genre: null,
              flags: 0,
            },
          ];
        }
        return out;
      },
    );

    const catalog = { epgWindow } as unknown as CatalogService;
    const commits: Array<{ focusedRow: number; focusedChannelKey: string | null }> = [];
    const i18n = createAppI18n('en');

    const view = await render(
      <ViewportProvider value={DESKTOP_VIEWPORT}>
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={i18n}>
            <EpgGridView
              catalog={catalog}
              category={makeCategory(total)}
              channelSource={channelSource}
              sourceVersion={0}
              refreshToken={0}
              nowMs={NOW_MS}
              activeChannelKey={targetKey}
              onWatchChannel={jest.fn()}
              onCursorCommit={(c) => {
                commits.push({
                  focusedRow: c.focusedRow,
                  focusedChannelKey: c.focusedChannelKey,
                });
              }}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(
        commits.some((c) => c.focusedRow === targetIndex && c.focusedChannelKey === targetKey),
      ).toBe(true);
    });

    // Non-TV programmatic auto-scroll must hydrate the visible range around targetIndex even without onScroll
    await waitFor(() => {
      const hydratedKeys = epgWindow.mock.calls.flatMap((call) => call[0]);
      expect(hydratedKeys).toContain(targetKey);
    });

    await view.unmount();
    channelSource.dispose();
  });
});
