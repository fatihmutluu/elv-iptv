import type { BrowseKind, CatalogService, EpisodeRow, SourceRow } from '@elv/data';
import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { FormFactorProvider, I18nProvider, RemoteKeysProvider } from '@elv/ui-kit';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { type ReactElement, useState } from 'react';
import { Platform, StyleSheet } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import * as BrowseParts from '../BrowseParts';
import { BrowseScreen } from '../BrowseScreen';
import { EMPTY_TAB_MEMORY, type TabBrowseMemory } from '../browse-model';
import { createFakeBrowseKeys, openBrowseTestCatalog } from './browse-test-harness';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;

function StatefulReviewBrowse({
  kind,
  catalog,
  sources,
  isActiveScope = true,
  onPlay,
  onMemorySpy,
}: {
  kind: BrowseKind;
  catalog: CatalogService;
  sources: readonly SourceRow[];
  isActiveScope?: boolean;
  onPlay: (target: PlayTarget) => void;
  onMemorySpy?: (next: TabBrowseMemory) => void;
}): ReactElement {
  const [memory, setMemory] = useState<TabBrowseMemory>(EMPTY_TAB_MEMORY);
  return (
    <BrowseScreen
      kind={kind}
      catalog={catalog}
      sources={sources}
      refreshToken={0}
      memory={memory}
      onMemoryChange={(next) => {
        onMemorySpy?.(next);
        setMemory(next);
      }}
      onPlay={onPlay}
      onOpenSources={() => undefined}
      isActiveScope={isActiveScope}
    />
  );
}

describe('BrowseScreen review regression fixes (#13)', () => {
  const originalOs = Platform.OS;

  beforeEach(() => {
    (Platform as { OS: string }).OS = 'android';
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    (Platform as { OS: string }).OS = originalOs;
    jest.restoreAllMocks();
  });

  it('clears TV FocusRing and row/button highlights when isActiveScope is false and restores remembered pane/row when true', async () => {
    const env = await openBrowseTestCatalog({ liveCount: 4 });
    const sources = await env.addAndImport('Demo');
    const keys = createFakeBrowseKeys();
    const onPlay = jest.fn();

    const tree = (active: boolean) => (
      <FormFactorProvider value="tv">
        <I18nProvider i18n={createAppI18n('en')}>
          <RemoteKeysProvider android={keys.source}>
            <StatefulReviewBrowse
              kind="live"
              catalog={env.catalog}
              sources={sources}
              isActiveScope={active}
              onPlay={onPlay}
            />
          </RemoteKeysProvider>
        </I18nProvider>
      </FormFactorProvider>
    );

    const view = await render(tree(true));
    await waitFor(() => {
      expect(screen.getByTestId('browse-categories-list-ring')).toBeTruthy();
    });

    await act(async () => {
      keys.tap(KEYCODE_DPAD_RIGHT);
    });
    await waitFor(() => {
      expect(screen.getByTestId('browse-items-list-ring')).toBeTruthy();
    });
    await act(async () => {
      keys.tap(KEYCODE_DPAD_DOWN);
    });
    expect(screen.getByTestId('browse-items-list-row-1').props.accessibilityState.selected).toBe(
      true,
    );

    await view.rerender(tree(false));
    expect(screen.queryByTestId('browse-categories-list-ring')).toBeNull();
    expect(screen.queryByTestId('browse-items-list-ring')).toBeNull();
    expect(screen.getByTestId('browse-items-list-row-1').props.accessibilityState.selected).toBe(
      false,
    );

    await view.rerender(tree(true));
    expect(screen.getByTestId('browse-items-list-ring')).toBeTruthy();
    expect(screen.getByTestId('browse-items-list-row-1').props.accessibilityState.selected).toBe(
      true,
    );

    await view.unmount();
    await env.cleanup();
  });

  it('gates empty-catalog and empty-seasons TV button highlights on isActiveScope and steps back on OK when seasons are empty', async () => {
    const env = await openBrowseTestCatalog();
    const keys = createFakeBrowseKeys();
    const onPlay = jest.fn();

    const emptyTree = (active: boolean) => (
      <FormFactorProvider value="tv">
        <I18nProvider i18n={createAppI18n('en')}>
          <RemoteKeysProvider android={keys.source}>
            <StatefulReviewBrowse
              kind="live"
              catalog={env.catalog}
              sources={[]}
              isActiveScope={active}
              onPlay={onPlay}
            />
          </RemoteKeysProvider>
        </I18nProvider>
      </FormFactorProvider>
    );

    const emptyView = await render(emptyTree(false));
    expect(
      StyleSheet.flatten(screen.getByTestId('browse-open-sources').props.style).borderColor,
    ).not.toBe('#ffffff');
    await emptyView.rerender(emptyTree(true));
    expect(
      StyleSheet.flatten(screen.getByTestId('browse-open-sources').props.style).borderColor,
    ).toBe('#ffffff');
    await emptyView.unmount();

    const sources = await env.addAndImport('Demo');
    const emptySeasonsCatalog: CatalogService = {
      ...env.catalog,
      seasons: async () => ok([]),
    };
    const seriesView = await render(
      <FormFactorProvider value="tv">
        <I18nProvider i18n={createAppI18n('en')}>
          <RemoteKeysProvider android={keys.source}>
            <StatefulReviewBrowse
              kind="series"
              catalog={emptySeasonsCatalog}
              sources={sources}
              isActiveScope
              onPlay={onPlay}
            />
          </RemoteKeysProvider>
        </I18nProvider>
      </FormFactorProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('browse-items-list-row-0')).toBeTruthy();
    });
    await act(async () => {
      keys.tap(KEYCODE_DPAD_RIGHT);
      keys.tap(KEYCODE_DPAD_CENTER);
    });

    await waitFor(() => {
      expect(screen.getByText('No seasons available for this series.')).toBeTruthy();
    });
    expect(
      StyleSheet.flatten(screen.getByTestId('series-back-series').props.style).borderColor,
    ).toBe('#ffffff');

    await act(async () => {
      keys.tap(KEYCODE_DPAD_CENTER);
    });
    await waitFor(() => {
      expect(screen.getByTestId('browse-items-list-row-0')).toBeTruthy();
    });

    await seriesView.unmount();
    await env.cleanup();
  });

  it('prevents focusing or playing stale Season 1 episodes while Season 2 episodes are still loading', async () => {
    const env = await openBrowseTestCatalog();
    const sources = await env.addAndImport('Demo');
    const keys = createFakeBrowseKeys();
    const onPlay = jest.fn();

    let resolveSeason2!: (rows: EpisodeRow[]) => void;
    const realEpisodes = env.catalog.episodes.bind(env.catalog);
    const slowCatalog: CatalogService = {
      ...env.catalog,
      episodes: (seriesId, season) => {
        if (season === 2) {
          return new Promise<EpisodeRow[]>((resolve) => {
            resolveSeason2 = resolve;
          });
        }
        return realEpisodes(seriesId, season);
      },
    };

    const view = await render(
      <FormFactorProvider value="tv">
        <I18nProvider i18n={createAppI18n('en')}>
          <RemoteKeysProvider android={keys.source}>
            <StatefulReviewBrowse
              kind="series"
              catalog={slowCatalog}
              sources={sources}
              isActiveScope
              onPlay={onPlay}
            />
          </RemoteKeysProvider>
        </I18nProvider>
      </FormFactorProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('browse-items-list-row-0')).toBeTruthy();
    });
    await act(async () => {
      keys.tap(KEYCODE_DPAD_RIGHT);
      keys.tap(KEYCODE_DPAD_CENTER);
    });
    await waitFor(() => {
      expect(screen.getByTestId('series-episodes-list-row-0')).toBeTruthy();
    });

    await act(async () => {
      keys.tap(KEYCODE_DPAD_DOWN);
    });
    expect(screen.queryByTestId('series-episodes-list')).toBeNull();

    await act(async () => {
      keys.tap(KEYCODE_DPAD_RIGHT);
      keys.tap(KEYCODE_DPAD_CENTER);
      keys.tap(KEYCODE_DPAD_CENTER);
    });
    expect(onPlay).not.toHaveBeenCalled();

    const s2Rows = await realEpisodes(1, 2);
    await act(async () => {
      resolveSeason2(s2Rows);
    });
    await waitFor(() => {
      expect(screen.getByTestId('series-episodes-list-row-0')).toBeTruthy();
    });
    await act(async () => {
      keys.tap(KEYCODE_DPAD_RIGHT);
      keys.tap(KEYCODE_DPAD_CENTER);
    });
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onPlay.mock.calls[0]?.[0]?.itemKey).toContain(':9003');

    await view.unmount();
    await env.cleanup();
  });

  it('handles queued Down + Right TV keys before re-render without overwriting categoryIndex back to 0, and re-renders <= 3 item slots per step', async () => {
    const env = await openBrowseTestCatalog({ liveCount: 30 });
    const sources = await env.addAndImport('Demo');
    const keys = createFakeBrowseKeys();
    const onPlay = jest.fn();
    let latestMemory: TabBrowseMemory = EMPTY_TAB_MEMORY;

    const rowSpy = jest.spyOn(BrowseParts, 'PlainListRow');

    const view = await render(
      <FormFactorProvider value="tv">
        <I18nProvider i18n={createAppI18n('en')}>
          <RemoteKeysProvider android={keys.source}>
            <StatefulReviewBrowse
              kind="live"
              catalog={env.catalog}
              sources={sources}
              isActiveScope
              onPlay={onPlay}
              onMemorySpy={(m) => {
                latestMemory = m;
              }}
            />
          </RemoteKeysProvider>
        </I18nProvider>
      </FormFactorProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('browse-items-list-row-0')).toBeTruthy();
    });

    await act(async () => {
      keys.tap(KEYCODE_DPAD_DOWN);
      keys.tap(KEYCODE_DPAD_RIGHT);
    });

    expect(latestMemory.categoryIndex).toBe(1);
    expect(latestMemory.activePane).toBe('items');
    await waitFor(() => {
      expect(screen.getByText('901. Regional One')).toBeTruthy();
    });

    await act(async () => {
      keys.tap(KEYCODE_DPAD_LEFT);
      keys.tap(KEYCODE_DPAD_UP);
    });
    await waitFor(() => {
      expect(screen.getByText('1. Channel 1')).toBeTruthy();
    });
    await act(async () => {
      keys.tap(KEYCODE_DPAD_RIGHT);
    });

    rowSpy.mockClear();
    await act(async () => {
      keys.tap(KEYCODE_DPAD_DOWN);
    });

    const catRowCalls = rowSpy.mock.calls.filter(([props]) => props.text.includes('('));
    const itemRowCalls = rowSpy.mock.calls.filter(([props]) => !props.text.includes('('));
    expect(catRowCalls.length).toBe(0);
    expect(itemRowCalls.length).toBeLessThanOrEqual(3);

    await view.unmount();
    await env.cleanup();
  });
});
