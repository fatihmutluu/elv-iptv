import type { CatalogService, ItemRow } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { act, render, screen } from '@testing-library/react-native';
import { createPagedListSource, type DisplayCategory, RouteActiveProvider } from '../../shared';
import { EpgGridView } from '../EpgGridView';

const BASE_NOW = new Date('2026-11-21T12:00:00Z').getTime();

function makeMockCatalog(): CatalogService {
  return {
    listSources: jest.fn(async () => []),
    addSource: jest.fn(),
    addSourceFromLink: jest.fn(),
    removeSource: jest.fn(),
    importSource: jest.fn(),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    seasons: jest.fn(async () => []),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(),
    epgWindow: jest.fn(async () => new Map()),
    close: jest.fn(async () => undefined),
  } as unknown as CatalogService;
}

const SAMPLE_CATEGORY: DisplayCategory = {
  row: {
    id: 'src-1|live|news',
    sourceId: 'src-1',
    kind: 'live',
    name: 'News',
    position: 0,
    itemCount: 1,
  },
  label: 'News',
};

const SAMPLE_CHANNELS: readonly ItemRow[] = [
  {
    id: 1,
    key: 'x:src-1:live:1',
    sourceId: 'src-1',
    providerId: '101',
    kind: 'live',
    name: 'News 1',
    logo: null,
    rating: null,
    year: null,
    num: 1,
  },
];

describe('EpgGridView route active freeze (#166)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(BASE_NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('freezes the live clock interval when RouteActiveProvider becomes inactive and refreshes immediately on resume', async () => {
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
    const catalog = makeMockCatalog();
    const channelSource = createPagedListSource<ItemRow>({
      count: SAMPLE_CHANNELS.length,
      pageSize: 60,
      maxPages: 2,
      loadPage: async (offset, limit) => SAMPLE_CHANNELS.slice(offset, offset + limit),
    });
    await channelSource.prefetch(0, 1);

    const renderTree = (active: boolean) => (
      <ViewportProvider
        value={{
          formFactor: 'desktop',
          orientation: 'landscape',
          inputModality: 'pointer',
          width: 1280,
          height: 800,
        }}
      >
        <ThemeProvider>
          <I18nProvider i18n={createAppI18n('en')}>
            <RouteActiveProvider active={active}>
              <EpgGridView
                catalog={catalog}
                category={SAMPLE_CATEGORY}
                channelSource={channelSource}
                sourceVersion={1}
                refreshToken={0}
                onWatchChannel={jest.fn()}
              />
            </RouteActiveProvider>
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>
    );

    const view = await render(renderTree(true));
    expect(screen.getByTestId('epg-time-ruler')).toBeTruthy();
    const intervalsAfterMount = setIntervalSpy.mock.calls.length;
    expect(intervalsAfterMount).toBeGreaterThanOrEqual(1);

    // Freeze route -> interval must be cleared immediately
    const clearsBeforeFreeze = clearIntervalSpy.mock.calls.length;
    await act(async () => {
      await view.rerender(renderTree(false));
    });
    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(clearsBeforeFreeze);

    // Advance system clock while frozen -> no interval callbacks re-arm
    const intervalsWhileFrozen = setIntervalSpy.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(90_000);
    });
    expect(setIntervalSpy.mock.calls.length).toBe(intervalsWhileFrozen);

    // Resume route -> immediately updates clock and restarts interval
    await act(async () => {
      await view.rerender(renderTree(true));
    });
    expect(setIntervalSpy.mock.calls.length).toBeGreaterThan(intervalsWhileFrozen);

    await view.unmount();
  });
});
