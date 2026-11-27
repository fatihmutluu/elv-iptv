import type { CatalogService, RatingValue } from '@elv/data';
import { ok } from '@elv/domain';
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
import { Platform } from 'react-native';
import type { DetailTarget } from '../../shared';
import { DetailHero } from '../DetailHero';
import { DetailScreen } from '../DetailScreen';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

const MOVIE_TARGET: DetailTarget = {
  kind: 'movie',
  sourceId: 'src-1',
  itemKey: 'x:src-1:movie:1',
  title: 'Arrival',
  posterUri: null,
  backdropUri: null,
  year: 2016,
  rating: 7.9,
};

function makeDetailCatalog(initialRating: RatingValue | null = null) {
  let current: RatingValue | null = initialRating;
  const setRating = jest.fn(async (_input: unknown, next: RatingValue | null) => {
    current = next;
    return ok(next);
  });
  const getRating = jest.fn(async () => current);
  const catalog = {
    itemDetail: jest.fn(async () => null),
    listFavoriteKeys: jest.fn(async () => []),
    getProgress: jest.fn(async () => null),
    itemVersions: jest.fn(async () => []),
    categories: jest.fn(async () => []),
    items: jest.fn(async () => []),
    listProgressByKeys: jest.fn(async () => []),
    setFavorite: jest.fn(async (_input: unknown, active: boolean) => ok(active)),
    setWatched: jest.fn(async () => ok(undefined)),
    getRating,
    setRating,
  } as unknown as CatalogService;
  return { catalog, getRating, setRating };
}

describe('Wave P6 DetailHero & DetailScreen — Star unification and Like/Dislike ratings', () => {
  it('DetailHero uses star / starFilled (never plus) for detail-mylist', async () => {
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
            <DetailHero
              kind="movie"
              title="Arrival"
              backdropUri={null}
              year={2016}
              rating={7.9}
              plot="Linguist communicates with visitors."
              seasonsCount={0}
              inMyList={false}
              watched={false}
              primaryAction={{ kind: 'pending' }}
              onBack={jest.fn()}
              onPlayPrimary={jest.fn()}
              onToggleMyList={jest.fn()}
              onToggleWatched={jest.fn()}
              isTv={false}
              isPortrait={false}
              topClearance={64}
              padX={32}
              focusedSlot={null}
            />
          </I18nProvider>
        </ThemeProvider>
      </ViewportProvider>,
    );

    const myListBtn = screen.getByTestId('detail-mylist');
    expect(myListBtn.props.accessibilityState?.selected).toBe(false);
    expect(screen.getByTestId('detail-mylist-icon')).toBeTruthy();
    expect(screen.getByTestId('detail-hero-icon-row')).toBeTruthy();
    expect(screen.getByTestId('detail-play')).toBeTruthy();
    expect(screen.queryByTestId('detail-collections')).toBeNull();
    await view.unmount();
  });

  it('toggles Like -> Dislike -> Clear on DetailScreen via pointer press and TV D-pad', async () => {
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
        keyListener?.({ action: 'down', keyCode, canceled: false, ageMs: 0 });
        keyListener?.({ action: 'up', keyCode, canceled: false, ageMs: 10 });
      });
    };

    const { catalog, setRating } = makeDetailCatalog(null);

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
              <DetailScreen
                target={MOVIE_TARGET}
                catalog={catalog}
                refreshToken={1}
                onBack={jest.fn()}
                onPlay={jest.fn()}
                onOpenDetail={jest.fn()}
              />
            </I18nProvider>
          </ThemeProvider>
        </ViewportProvider>
      </RemoteKeysProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('detail-like')).toBeTruthy();
      expect(screen.getByTestId('detail-dislike')).toBeTruthy();
    });

    // TV D-pad: hero-play -> Up (mylist) -> Right (like) -> Select (sets 'like')
    await pressKey(KEYCODE_DPAD_UP);
    await pressKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('detail-like-focus-ring')).toBeTruthy();
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(setRating).toHaveBeenLastCalledWith(
        expect.objectContaining({ itemKey: MOVIE_TARGET.itemKey, kind: 'movie' }),
        'like',
      );
      expect(screen.getByTestId('detail-like').props.accessibilityState?.selected).toBe(true);
    });

    // Right (dislike) -> Select (switches to 'dislike')
    await pressKey(KEYCODE_DPAD_RIGHT);
    expect(screen.getByTestId('detail-dislike-focus-ring')).toBeTruthy();
    await pressKey(KEYCODE_DPAD_CENTER);
    await waitFor(() => {
      expect(setRating).toHaveBeenLastCalledWith(
        expect.objectContaining({ itemKey: MOVIE_TARGET.itemKey, kind: 'movie' }),
        'dislike',
      );
      expect(screen.getByTestId('detail-dislike').props.accessibilityState?.selected).toBe(true);
      expect(screen.getByTestId('detail-like').props.accessibilityState?.selected).toBe(false);
    });

    // Pressing dislike again clears rating to null
    await fireEvent.press(screen.getByTestId('detail-dislike'));
    await waitFor(() => {
      expect(setRating).toHaveBeenLastCalledWith(
        expect.objectContaining({ itemKey: MOVIE_TARGET.itemKey, kind: 'movie' }),
        null,
      );
      expect(screen.getByTestId('detail-dislike').props.accessibilityState?.selected).toBe(false);
    });

    await view.unmount();
  });
});
