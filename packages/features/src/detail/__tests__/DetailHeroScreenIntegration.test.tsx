import type { CatalogService, ElvItemEnrichment, ElvTitleRecord } from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { I18nProvider, ThemeProvider, useTheme, ViewportProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { DetailTarget } from '../../shared';
import * as desktopDialogTrap from '../../shared/desktop-dialog-trap';
import { DetailScreen } from '../DetailScreen';
import type { DetailVersionOption } from '../detail-data-helpers';
import { DETAIL_TRAILER_AUTOPLAY_DELAY_MS } from '../detail-trailer-preview-model';
import { useDetailExtrasState } from '../useDetailExtrasState';

const flat = StyleSheet.flatten;

function ExtrasFontScaleProbe({
  target,
  plot,
}: {
  readonly target: DetailTarget;
  readonly plot: string;
}): ReactElement {
  const theme = useTheme();
  const state = useDetailExtrasState({
    target,
    plot,
    isPortrait: false,
    fontScale: theme.fontScale,
  });
  return <View testID={state.heroPlaySlots.includes('synopsis') ? 'slot-yes' : 'slot-no'} />;
}

function collectTestIds(node: unknown, out: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectTestIds(child, out);
    return out;
  }
  const el = node as { props?: Record<string, unknown>; children?: unknown[] };
  if (typeof el.props?.testID === 'string') out.push(el.props.testID);
  if (Array.isArray(el.children)) {
    for (const child of el.children) collectTestIds(child, out);
  }
  return out;
}

const LONG_SYNOPSIS =
  'In a quiet orbital listening station suspended above the twilight meridian, a veteran engineer uncovers a recurring signal hidden beneath decades of archived telemetry. As rival relays begin shutting down one by one, the crew must decide whether to broadcast the message back home or seal the beacon forever before orbit decays.';

const VERSIONS: readonly DetailVersionOption[] = [
  { key: 'm1', title: 'Beacon Horizon [4K]', versionLabel: '4K', year: 2026, qualityRank: 40 },
  {
    key: 'm2',
    title: 'Beacon Horizon [1080p]',
    versionLabel: '1080p',
    year: 2026,
    qualityRank: 30,
  },
];

function makeEnrichedTitle(
  itemKey: string,
  synopsis: string,
): {
  title: ElvTitleRecord;
  enrichment: ElvItemEnrichment;
} {
  const title: ElvTitleRecord = {
    imdbId: 'tt9901001',
    mediaType: 'movie',
    originalTitle: 'Beacon Horizon',
    englishTitle: 'Beacon Horizon',
    localizedTitles: {},
    year: 2026,
    rating: 8.3,
    votes: 420_000,
    runtimeMin: 150,
    genres: ['Sci-Fi'],
    posterUrl: 'https://img.example/poster.jpg',
    backdropUrl: 'https://img.example/backdrop.jpg',
    trailerStreamUrl: 'https://cdn.example.com/trailers/beacon.mp4',
    trailerYoutubeId: null,
    director: 'Elena Vance',
    cast: [],
    mltImdbIds: [],
    franchiseKey: null,
    franchiseName: null,
    franchiseOrder: null,
    synopses: { en: synopsis },
    detailFetchedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
  return {
    title,
    enrichment: {
      itemKey,
      sourceId: 's1',
      mediaType: 'movie',
      imdbId: title.imdbId,
      confidence: 0.99,
      manualLock: false,
      title,
    },
  };
}

describe('Wave R2-B DetailScreen Multi-Version Popover & Trailer Suppression', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('opens multi-version popover above trigger cleanly and pauses background trailer while popover is open', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    jest.useFakeTimers();

    const { title: titleRec, enrichment } = makeEnrichedTitle('m1', LONG_SYNOPSIS);
    const catalog = {
      itemDetail: jest.fn(async () => ({
        id: 1,
        key: 'm1',
        sourceId: 's1',
        providerId: '1',
        kind: 'movie' as const,
        name: 'Beacon Horizon',
        num: null,
        logo: null,
        year: 2026,
        rating: 8.3,
        plot: LONG_SYNOPSIS,
      })),
      listFavoriteKeys: jest.fn(async () => []),
      getProgress: jest.fn(async () => null),
      itemVersions: jest.fn(async () => [...VERSIONS]),
      getElvEnrichmentForKeys: jest.fn(
        async () => new Map<string, ElvItemEnrichment>([['m1', enrichment]]),
      ),
      getElvTitleDetail: jest.fn(async () => titleRec),
      listElvFranchiseItems: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
      getRating: jest.fn(async () => null),
    } as unknown as CatalogService;

    const view = await render(
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
            <DetailScreen
              target={{
                itemKey: 'm1',
                sourceId: 's1',
                kind: 'movie',
                title: 'Beacon Horizon',
                posterUri: null,
                backdropUri: 'https://img.example/backdrop.jpg',
                year: 2026,
                rating: 8.3,
                overview: LONG_SYNOPSIS,
              }}
              catalog={catalog}
              elvPreferences={{
                ...DEFAULT_ELV_MODE_PREFERENCES,
                elvModeEnabled: true,
                elvEnrichMetadata: true,
              }}
              refreshToken={1}
              onBack={jest.fn()}
              onPlay={jest.fn()}
              onOpenDetail={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-preplay-version')).toBeTruthy();
      expect(screen.getByTestId('detail-synopsis-toggle')).toBeTruthy();
    });

    await act(async () => {
      jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS + 50);
    });
    expect(screen.getByTestId('detail-trailer-preview')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('detail-preplay-version'));
    const backdropStyle = flat(screen.getByTestId('detail-preplay-version-backdrop').props.style);
    expect(backdropStyle.position).toBe('fixed');
    expect(backdropStyle.top).toBe(0);
    expect(backdropStyle.right).toBe(0);
    expect(backdropStyle.bottom).toBe(0);
    expect(backdropStyle.left).toBe(0);
    const menuStyle = flat(screen.getByTestId('detail-preplay-version-menu').props.style);
    expect(menuStyle.bottom).toBe('100%');
    expect(menuStyle.marginBottom).toBe(6);
    expect(screen.queryByTestId('detail-trailer-preview')).toBeNull();

    await fireEvent.press(screen.getByTestId('detail-preplay-version-option-1'));
    expect(screen.queryByTestId('detail-preplay-version-menu')).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(DETAIL_TRAILER_AUTOPLAY_DELAY_MS + 50);
    });
    expect(screen.getByTestId('detail-trailer-preview')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('detail-synopsis-toggle'));
    expect(screen.getByTestId('detail-synopsis-popover')).toBeTruthy();
    expect(screen.queryByTestId('detail-trailer-preview')).toBeNull();

    await view.unmount();
  });

  it('wires useDesktopDialogTrap, accessible backdrop attributes, and Enter/Space keyboard activation on detail-synopsis-toggle', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const trapSpy = jest.spyOn(desktopDialogTrap, 'useDesktopDialogTrap');
    const catalog = {
      itemDetail: jest.fn(async () => null),
      listFavoriteKeys: jest.fn(async () => []),
      getProgress: jest.fn(async () => null),
      itemVersions: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
      getRating: jest.fn(async () => null),
    } as unknown as CatalogService;

    const view = await render(
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
            <DetailScreen
              target={{
                itemKey: 'm:kbd',
                sourceId: 's1',
                kind: 'movie',
                title: 'Keyboard Popover Movie',
                posterUri: null,
                backdropUri: null,
                year: 2026,
                rating: 8.2,
                overview: LONG_SYNOPSIS,
              }}
              catalog={catalog}
              refreshToken={1}
              onBack={jest.fn()}
              onPlay={jest.fn()}
              onOpenDetail={jest.fn()}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    const toggle = await waitFor(() => screen.getByTestId('detail-synopsis-toggle'));
    expect(toggle.props.tabIndex).toBe(0);
    expect(trapSpy).toHaveBeenLastCalledWith(expect.any(Object), false, expect.any(Function));

    // Enter activates inline trigger with preventDefault
    const preventEnter = jest.fn();
    await fireEvent(toggle, 'keyDown', { key: 'Enter', preventDefault: preventEnter });
    expect(preventEnter).toHaveBeenCalledTimes(1);

    const dialogWrapper = screen.getByTestId('detail-synopsis-popover-dialog');
    expect(dialogWrapper.props.accessibilityViewIsModal).toBe(true);
    expect(trapSpy).toHaveBeenLastCalledWith(expect.any(Object), true, expect.any(Function));

    const backdrop = screen.getByTestId('detail-synopsis-popover-backdrop', {
      includeHiddenElements: true,
    });
    expect(backdrop.props.accessible).toBe(false);
    expect(backdrop.props.focusable).toBe(false);
    expect(backdrop.props.tabIndex).toBe(-1);
    expect(backdrop.props['aria-hidden']).toBe(true);
    const ids = collectTestIds(view.toJSON());
    expect(ids.indexOf('detail-synopsis-popover')).toBeGreaterThan(
      ids.indexOf('detail-synopsis-popover-backdrop'),
    );

    // Background toggle is isolated by accessibilityViewIsModal while popover is open
    expect(screen.queryByTestId('detail-synopsis-toggle')).toBeNull();

    // Closing via × restores background toggle accessibility, then Spacebar re-opens popover
    await fireEvent.press(screen.getByTestId('detail-synopsis-popover-close'));
    expect(screen.queryByTestId('detail-synopsis-popover')).toBeNull();

    const preventSpace = jest.fn();
    await fireEvent(screen.getByTestId('detail-synopsis-toggle'), 'keyDown', {
      key: ' ',
      preventDefault: preventSpace,
    });
    expect(preventSpace).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('detail-synopsis-popover')).toBeTruthy();

    await view.unmount();
  });

  it('syncs canExpandSynopsis and TV synopsis focus slot with theme.fontScale (1.2 vs 0.9)', async () => {
    const midPlot =
      'In a remote coastal beacon above the northern tidewall, two archivists recover fragmented broadcast transmissions spanning three decades before the final storm cuts off every single outer northern island relay.';
    expect(midPlot.length).toBeGreaterThan(196);
    expect(midPlot.length).toBeLessThan(235);

    const target = {
      itemKey: 'm:scale',
      sourceId: 's1',
      kind: 'movie' as const,
      title: 'Scale Sync',
      posterUri: null,
      backdropUri: null,
      year: 2026,
      rating: 8.0,
      overview: midPlot,
    };

    const catalog = {
      itemDetail: jest.fn(async () => null),
      listFavoriteKeys: jest.fn(async () => []),
      getProgress: jest.fn(async () => null),
      itemVersions: jest.fn(async () => []),
      categories: jest.fn(async () => []),
      items: jest.fn(async () => []),
      listProgressByKeys: jest.fn(async () => []),
      getRating: jest.fn(async () => null),
    } as unknown as CatalogService;

    const largeView = await render(
      <ViewportProvider
        value={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      >
        <ThemeProvider fontScale={1.2}>
          <I18nProvider i18n={createAppI18n('en')}>
            <View>
              <ExtrasFontScaleProbe target={target} plot={midPlot} />
              <DetailScreen
                target={target}
                catalog={catalog}
                refreshToken={1}
                onBack={jest.fn()}
                onPlay={jest.fn()}
                onOpenDetail={jest.fn()}
              />
            </View>
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('detail-synopsis-toggle')).toBeTruthy();
      expect(screen.getByTestId('slot-yes')).toBeTruthy();
    });
    await largeView.unmount();

    const smallView = await render(
      <ViewportProvider
        value={{
          formFactor: 'tv',
          orientation: 'landscape',
          inputModality: 'tv',
          width: 1920,
          height: 1080,
        }}
      >
        <ThemeProvider fontScale={0.9}>
          <I18nProvider i18n={createAppI18n('en')}>
            <View>
              <ExtrasFontScaleProbe target={target} plot={midPlot} />
              <DetailScreen
                target={target}
                catalog={catalog}
                refreshToken={1}
                onBack={jest.fn()}
                onPlay={jest.fn()}
                onOpenDetail={jest.fn()}
              />
            </View>
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('detail-synopsis')).toBeTruthy();
      expect(screen.getByTestId('slot-no')).toBeTruthy();
    });
    expect(screen.queryByTestId('detail-synopsis-toggle')).toBeNull();
    await smallView.unmount();
  });
});
