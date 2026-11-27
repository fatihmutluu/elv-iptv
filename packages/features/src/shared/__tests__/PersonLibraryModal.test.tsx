import type { CatalogService, ElvPersonLibraryItem } from '@elv/data';
import { DEFAULT_ELV_MODE_PREFERENCES, type ElvModePreferences } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform, ScrollView } from 'react-native';
import {
  PersonLibraryModal,
  type PersonLibraryModalPerson,
  splitDirectorNames,
} from '../PersonLibraryModal';

const KEYCODE_BACK = 4;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

const ELV_ON: ElvModePreferences = {
  ...DEFAULT_ELV_MODE_PREFERENCES,
  elvModeEnabled: true,
  elvEnrichMetadata: true,
};

function makePersonEntry(overrides: Partial<ElvPersonLibraryItem> = {}): ElvPersonLibraryItem {
  return {
    item: {
      id: 101,
      sourceId: 'src-1',
      kind: 'movie',
      providerId: '101',
      key: 'x:src-1:movie:101',
      name: 'Raw Inception 4K',
      num: null,
      logo: 'https://provider.invalid/raw.jpg',
      year: 2010,
      rating: 8.8,
    },
    enrichment: {
      itemKey: 'x:src-1:movie:101',
      sourceId: 'src-1',
      mediaType: 'movie',
      imdbId: 'tt1375666',
      confidence: 0.99,
      manualLock: false,
      title: {
        imdbId: 'tt1375666',
        mediaType: 'movie',
        originalTitle: 'Inception',
        englishTitle: 'Inception',
        localizedTitles: { tr: 'Başlangıç' },
        year: 2010,
        rating: 8.8,
        votes: 2_500_000,
        runtimeMin: 148,
        genres: ['Action', 'Sci-Fi'],
        posterUrl: 'https://imdb.invalid/inception.jpg',
        backdropUrl: 'https://imdb.invalid/inception-bg.jpg',
        trailerStreamUrl: null,
        trailerYoutubeId: null,
        director: 'Christopher Nolan',
        cast: [{ personId: 'nm0000138', name: 'Leonardo DiCaprio', character: 'Cobb' }],
        mltImdbIds: [],
        franchiseKey: null,
        franchiseName: null,
        franchiseOrder: null,
        synopses: {},
        detailFetchedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
    },
    role: 'cast',
    character: 'Cobb',
    ...overrides,
  };
}

describe('PersonLibraryModal (#512)', () => {
  it('renders person header, library count, ELV formatted cards with role badges, and opens selected item', async () => {
    const baseEntry = makePersonEntry();
    const baseTitle = baseEntry.enrichment.title;
    if (baseTitle === null) throw new Error('expected fixture title');
    const entries: readonly ElvPersonLibraryItem[] = [
      baseEntry,
      makePersonEntry({
        item: {
          id: 102,
          sourceId: 'src-1',
          kind: 'movie',
          providerId: '102',
          key: 'x:src-1:movie:102',
          name: 'Raw Interstellar',
          num: null,
          logo: null,
          year: 2014,
          rating: 8.7,
        },
        enrichment: {
          ...baseEntry.enrichment,
          itemKey: 'x:src-1:movie:102',
          imdbId: 'tt0816692',
          title: {
            ...baseTitle,
            imdbId: 'tt0816692',
            originalTitle: 'Interstellar',
            englishTitle: 'Interstellar',
            localizedTitles: {},
            year: 2014,
            rating: 8.7,
            posterUrl: 'https://imdb.invalid/interstellar.jpg',
          },
        },
        role: 'director',
        character: null,
      }),
    ];
    const listElvPersonLibraryItems = jest.fn(async () => entries);
    const catalog = { listElvPersonLibraryItems } as unknown as CatalogService;
    const onSelectItem = jest.fn();
    const onClose = jest.fn();
    const person: PersonLibraryModalPerson = {
      personId: 'nm0000138',
      name: 'Leonardo DiCaprio',
      portraitUrl: 'https://imdb.invalid/leo.jpg',
    };

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
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <PersonLibraryModal
              visible
              person={person}
              catalog={catalog}
              elvPreferences={ELV_ON}
              onSelectItem={onSelectItem}
              onClose={onClose}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(listElvPersonLibraryItems).toHaveBeenCalledWith({
        personId: 'nm0000138',
        name: 'Leonardo DiCaprio',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('person-library-item-0')).toBeTruthy();
      expect(screen.getByTestId('person-library-item-1')).toBeTruthy();
    });

    expect(screen.getByText('Leonardo DiCaprio')).toBeTruthy();
    expect(screen.getByText('In your library (2)')).toBeTruthy();
    expect(screen.getByText('Inception')).toBeTruthy();
    expect(screen.getByText('Cast · Cobb')).toBeTruthy();
    expect(screen.getByText('Director')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('person-library-item-0'));
    expect(onSelectItem).toHaveBeenCalledWith(
      expect.objectContaining({
        itemKey: 'x:src-1:movie:101',
        sourceId: 'src-1',
        kind: 'movie',
        title: 'Inception',
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('shows empty state when no matching titles exist in library', async () => {
    const listElvPersonLibraryItems = jest.fn(async () => []);
    const catalog = { listElvPersonLibraryItems } as unknown as CatalogService;
    const onClose = jest.fn();

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
        <ThemeProvider preset="obsidianCrimson">
          <I18nProvider i18n={createAppI18n('en')}>
            <PersonLibraryModal
              visible
              person={{ name: 'Denis Villeneuve' }}
              catalog={catalog}
              onSelectItem={jest.fn()}
              onClose={onClose}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('person-library-empty')).toBeTruthy();
    });
    expect(screen.getByText('No other matching titles found in your IPTV library.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('person-library-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('supports 10-ft TV D-pad navigation and Back dismissal without RN Modal', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return {
          remove: () => {
            keyListener = undefined;
          },
        };
      },
    };
    const pressKey = async (keyCode: number) => {
      await act(async () => {
        keyListener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
        keyListener?.({ keyCode, action: 'up', canceled: false, ageMs: 10 });
      });
    };

    const entries = [makePersonEntry()];
    const catalog = {
      listElvPersonLibraryItems: jest.fn(async () => entries),
    } as unknown as CatalogService;
    const onSelectItem = jest.fn();
    const onClose = jest.fn();

    const view = await render(
      <RemoteKeysProvider android={androidSource}>
        <ViewportProvider
          value={{
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1920,
            height: 1080,
          }}
        >
          <ThemeProvider preset="obsidianCrimson">
            <I18nProvider i18n={createAppI18n('en')}>
              <PersonLibraryModal
                visible
                person={{ personId: 'nm0000138', name: 'Leonardo DiCaprio' }}
                catalog={catalog}
                elvPreferences={ELV_ON}
                onSelectItem={onSelectItem}
                onClose={onClose}
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('person-library-item-0')).toBeTruthy();
    });
    expect(
      screen.getByTestId('person-library-tv-anchor', { includeHiddenElements: true }),
    ).toBeTruthy();

    await pressKey(KEYCODE_DPAD_RIGHT);
    await pressKey(KEYCODE_DPAD_CENTER);
    expect(onSelectItem).toHaveBeenCalledTimes(1);

    await pressKey(KEYCODE_BACK);
    expect(onClose).toHaveBeenCalled();

    await view.unmount();
  });

  it('auto-scrolls HorizontalRailScroll on TV when tvFocusIndex advances (P1 #5)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);

    let keyListener: ((e: AndroidKeyEvent) => void) | undefined;
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        keyListener = l;
        return {
          remove: () => {
            keyListener = undefined;
          },
        };
      },
    };
    const pressKey = async (keyCode: number) => {
      await act(async () => {
        keyListener?.({ keyCode, action: 'down', canceled: false, ageMs: 0 });
        keyListener?.({ keyCode, action: 'up', canceled: false, ageMs: 10 });
      });
    };

    const entries = [0, 1, 2, 3].map((idx) =>
      makePersonEntry({
        item: {
          ...makePersonEntry().item,
          id: 200 + idx,
          key: `x:src-1:movie:${200 + idx}`,
          name: `Movie ${idx}`,
        },
      }),
    );
    const catalog = {
      listElvPersonLibraryItems: jest.fn(async () => entries),
    } as unknown as CatalogService;
    const scrollToSpy = jest
      .spyOn(ScrollView.prototype, 'scrollTo')
      .mockImplementation(() => undefined);

    const view = await render(
      <RemoteKeysProvider android={androidSource}>
        <ViewportProvider
          value={{
            formFactor: 'tv',
            orientation: 'landscape',
            inputModality: 'tv',
            width: 1920,
            height: 1080,
          }}
        >
          <ThemeProvider preset="obsidianCrimson">
            <I18nProvider i18n={createAppI18n('en')}>
              <PersonLibraryModal
                visible
                person={{ personId: 'nm0000138', name: 'Leonardo DiCaprio' }}
                catalog={catalog}
                elvPreferences={ELV_ON}
                onSelectItem={jest.fn()}
                onClose={jest.fn()}
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('person-library-item-3')).toBeTruthy();
    });
    scrollToSpy.mockClear();

    await pressKey(KEYCODE_DPAD_RIGHT); // focus index 0
    await pressKey(KEYCODE_DPAD_RIGHT); // focus index 1
    await pressKey(KEYCODE_DPAD_RIGHT); // focus index 2
    expect(scrollToSpy).toHaveBeenCalledWith(expect.objectContaining({ x: expect.any(Number) }));
    const lastCall = scrollToSpy.mock.calls[scrollToSpy.mock.calls.length - 1]?.[0] as
      | { x?: number }
      | undefined;
    expect(lastCall?.x ?? 0).toBeGreaterThan(0);

    scrollToSpy.mockRestore();
    await view.unmount();
  });

  it('splits comma and ampersand separated co-director names cleanly', () => {
    expect(splitDirectorNames('Joel Coen, Ethan Coen')).toEqual(['Joel Coen', 'Ethan Coen']);
    expect(splitDirectorNames('Lana Wachowski & Lilly Wachowski')).toEqual([
      'Lana Wachowski',
      'Lilly Wachowski',
    ]);
    expect(splitDirectorNames('Denis Villeneuve')).toEqual(['Denis Villeneuve']);
    expect(splitDirectorNames('  ')).toEqual([]);
    expect(splitDirectorNames(null)).toEqual([]);
  });
});
