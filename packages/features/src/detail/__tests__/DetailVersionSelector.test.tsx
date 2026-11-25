import type { CatalogService } from '@elv/data';
import { ok } from '@elv/domain';
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
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Platform } from 'react-native';
import { DetailScreen } from '../DetailScreen';

const EN_I18N = createAppI18n('en');
const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

function wrap(
  node: ReactElement,
  opts: { viewport?: ViewportOverride; androidSource?: AndroidKeySource } = {},
) {
  const inner = (
    <ThemeProvider>
      <I18nProvider i18n={EN_I18N}>
        <ViewportProvider
          value={opts.viewport ?? { width: 1280, height: 720, formFactor: 'desktop' }}
        >
          {node}
        </ViewportProvider>
      </I18nProvider>
    </ThemeProvider>
  );
  if (opts.androidSource) {
    return <RemoteKeysProvider android={opts.androidSource}>{inner}</RemoteKeysProvider>;
  }
  return inner;
}

function makeStubCatalog(overrides: Partial<CatalogService> = {}): CatalogService {
  return {
    addSource: jest.fn(async () =>
      ok({ id: 's1', kind: 'xtream' as const, name: 'X', createdAt: 1, needsImport: true }),
    ),
    addSourceFromLink: jest.fn(async () =>
      ok({ id: 's1', kind: 'm3u' as const, name: 'M', createdAt: 1, needsImport: true }),
    ),
    removeSource: jest.fn(async () => ok(undefined)),
    importSource: jest.fn(async () =>
      ok({
        runId: 1,
        counts: { live: 0, movies: 2, series: 0 },
        warnings: 0,
        warningCodes: [],
        durationMs: 10,
      }),
    ),
    listSources: jest.fn(async () => []),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    seasons: jest.fn(async () => ok([])),
    episodes: jest.fn(async () => []),
    resolveStream: jest.fn(async () => ok({ url: 'http://127.0.0.1/1.mp4', headers: {} })),
    close: jest.fn(async () => undefined),
    ...overrides,
  };
}

function makeMultiVersionCatalog() {
  return makeStubCatalog({
    itemDetail: jest.fn(async () => ({
      id: 1,
      key: 'x:s1:movie:1',
      sourceId: 's1',
      providerId: '1',
      kind: 'movie' as const,
      name: 'Dune',
      year: 2021,
      rating: 8.2,
      num: null,
      logo: null,
      plot: 'Desert planet.',
    })),
    getProgress: jest.fn(async () => ({
      profileId: 'default',
      sourceId: 's1',
      itemKey: 'x:s1:movie:1',
      kind: 'movie' as const,
      title: 'Dune',
      subtitle: null,
      logo: null,
      seriesKey: null,
      season: null,
      episode: null,
      positionMs: 60_000,
      durationMs: 7_200_000,
      watched: false,
      updatedAt: 1,
      preferredItemKey: 'x:s1:movie:2',
    })),
    itemVersions: jest.fn(async () => [
      {
        key: 'x:s1:movie:1',
        title: 'Dune [4K]',
        versionLabel: '4K',
        year: 2021,
        qualityRank: 40,
      },
      {
        key: 'x:s1:movie:2',
        title: 'Dune [1080p]',
        versionLabel: '1080p',
        year: 2021,
        qualityRank: 30,
      },
    ]),
  });
}

describe('DetailScreen multi-version VOD dropdown (#404)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens version dropdown, displays active checkmark, selects version, closes menu, and omits audio/subtitle pre-play buttons', async () => {
    const onPlay = jest.fn();
    const catalog = makeMultiVersionCatalog();

    const screen = await render(
      wrap(
        <DetailScreen
          target={{
            itemKey: 'x:s1:movie:1',
            sourceId: 's1',
            kind: 'movie',
            title: 'Dune',
            posterUri: null,
            backdropUri: null,
            year: 2021,
            rating: 8.2,
          }}
          catalog={catalog}
          refreshToken={0}
          onBack={jest.fn()}
          onPlay={onPlay}
          onOpenDetail={jest.fn()}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByTestId('detail-preplay-version-dropdown')).toBeTruthy());
    expect(screen.queryByTestId('detail-preplay-audio')).toBeNull();
    expect(screen.queryByTestId('detail-preplay-subtitles')).toBeNull();
    expect(screen.getByTestId('detail-preplay-version')).toHaveTextContent(/1080p/);
    expect(screen.queryByTestId('detail-preplay-version-menu')).toBeNull();

    // Open dropdown menu
    await fireEvent.press(screen.getByTestId('detail-preplay-version'));
    expect(screen.getByTestId('detail-preplay-version-menu')).toBeTruthy();
    expect(screen.getByTestId('detail-preplay-version-option-0')).toHaveTextContent('4K');
    expect(screen.getByTestId('detail-preplay-version-option-1')).toHaveTextContent('1080p');
    expect(screen.queryByTestId('detail-preplay-version-check-0')).toBeNull();
    expect(screen.getByTestId('detail-preplay-version-check-1')).toBeTruthy();

    // Click outside backdrop dismisses menu without changing selection
    await fireEvent.press(screen.getByTestId('detail-preplay-version-backdrop'));
    expect(screen.queryByTestId('detail-preplay-version-menu')).toBeNull();
    expect(screen.getByTestId('detail-preplay-version')).toHaveTextContent(/1080p/);

    // Re-open and pick 4K
    await fireEvent.press(screen.getByTestId('detail-preplay-version'));
    await fireEvent.press(screen.getByTestId('detail-preplay-version-option-0'));
    expect(screen.queryByTestId('detail-preplay-version-menu')).toBeNull();
    expect(screen.getByTestId('detail-preplay-version')).toHaveTextContent(/4K/);

    await fireEvent.press(screen.getByTestId('detail-play'));
    expect(onPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'x:s1:movie:1',
        title: 'Dune [4K]',
      }),
    );

    await screen.unmount();
  });

  it('does not render version dropdown when only one version exists', async () => {
    const catalog = makeStubCatalog({
      itemVersions: jest.fn(async () => [
        {
          key: 'x:s1:movie:1',
          title: 'Dune [1080p]',
          versionLabel: '1080p',
          year: 2021,
          qualityRank: 30,
        },
      ]),
    });

    const screen = await render(
      wrap(
        <DetailScreen
          target={{
            itemKey: 'x:s1:movie:1',
            sourceId: 's1',
            kind: 'movie',
            title: 'Dune',
            posterUri: null,
            backdropUri: null,
            year: 2021,
            rating: 8.2,
          }}
          catalog={catalog}
          refreshToken={0}
          onBack={jest.fn()}
          onPlay={jest.fn()}
          onOpenDetail={jest.fn()}
        />,
      ),
    );

    await waitFor(() => expect(screen.getByTestId('detail-play')).toBeTruthy());
    expect(screen.queryByTestId('detail-preplay-version-dropdown')).toBeNull();
    expect(screen.queryByTestId('detail-preplay-version')).toBeNull();
    expect(screen.queryByTestId('detail-preplay-audio')).toBeNull();
    expect(screen.queryByTestId('detail-preplay-subtitles')).toBeNull();

    await screen.unmount();
  });

  it('supports TV D-pad open, navigate, Back dismiss, and Select inside version dropdown', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    let listener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        listener = l;
        return {
          remove: () => {
            listener = undefined;
          },
        };
      },
    };
    const pressKey = async (keyCode: number) => {
      await act(async () => {
        listener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
        listener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
      });
    };

    const onPlay = jest.fn();
    const onBack = jest.fn();
    const catalog = makeMultiVersionCatalog();

    const screen = await render(
      wrap(
        <DetailScreen
          target={{
            itemKey: 'x:s1:movie:1',
            sourceId: 's1',
            kind: 'movie',
            title: 'Dune',
            posterUri: null,
            backdropUri: null,
            year: 2021,
            rating: 8.2,
          }}
          catalog={catalog}
          refreshToken={0}
          onBack={onBack}
          onPlay={onPlay}
          onOpenDetail={jest.fn()}
          isActiveScope
        />,
        {
          viewport: {
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1920,
            height: 1080,
          },
          androidSource,
        },
      ),
    );

    await waitFor(() => expect(screen.getByTestId('detail-preplay-version')).toBeTruthy());

    // Play -> Right focuses version dropdown trigger
    await pressKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('detail-preplay-version-focus-ring')).toBeTruthy();

    // Select opens dropdown menu; Back closes it without popping DetailScreen
    await pressKey(KEYCODE_DPAD_CENTER);
    expect(screen.getByTestId('detail-preplay-version-menu')).toBeTruthy();
    await pressKey(KEYCODE_BACK);
    expect(screen.queryByTestId('detail-preplay-version-menu')).toBeNull();
    expect(onBack).not.toHaveBeenCalled();

    // Re-open, move up from index 1 (1080p) to index 0 (4K), Select picks 4K
    await pressKey(KEYCODE_DPAD_CENTER);
    await pressKey(KEYCODE_DPAD_UP);
    await pressKey(KEYCODE_DPAD_CENTER);
    expect(screen.queryByTestId('detail-preplay-version-menu')).toBeNull();
    expect(screen.getByTestId('detail-preplay-version')).toHaveTextContent(/4K/);

    await screen.unmount();
  });
});
