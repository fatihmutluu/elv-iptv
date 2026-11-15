import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeySource,
  type FormFactor,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
} from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useState } from 'react';
import { Platform } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import { BrowseScreen, type BrowseScreenProps } from '../BrowseScreen';
import { EMPTY_TAB_MEMORY, type TabBrowseMemory } from '../browse-model';
import { createFakeBrowseKeys, openBrowseTestCatalog } from './browse-test-harness';

const KEYCODE_DPAD_UP = 19;
const KEYCODE_DPAD_DOWN = 20;
const KEYCODE_DPAD_LEFT = 21;
const KEYCODE_DPAD_RIGHT = 22;
const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_BACK = 4;

function StatefulSeriesBrowse({
  formFactor,
  androidKeys,
  ...props
}: Omit<BrowseScreenProps, 'memory' | 'onMemoryChange'> & {
  formFactor: FormFactor;
  androidKeys?: AndroidKeySource;
}) {
  const [memory, setMemory] = useState<TabBrowseMemory>(EMPTY_TAB_MEMORY);
  const inner = (
    <FormFactorProvider value={formFactor}>
      <I18nProvider i18n={createAppI18n('en')}>
        <BrowseScreen {...props} memory={memory} onMemoryChange={setMemory} />
      </I18nProvider>
    </FormFactorProvider>
  );
  return androidKeys !== undefined ? (
    <RemoteKeysProvider android={androidKeys}>{inner}</RemoteKeysProvider>
  ) : (
    inner
  );
}

describe('BrowseScreen series drilldown and form-factor navigation', () => {
  beforeEach(() => {
    jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads Xtream seasons on demand, retries after network/unreachable, and plays an episode as vod', async () => {
    const env = await openBrowseTestCatalog({ failSeriesInfoAttempts: 1 });
    try {
      const sources = await env.addAndImport('Demo');
      const onPlay = jest.fn<void, [PlayTarget]>();

      const view = await render(
        <StatefulSeriesBrowse
          formFactor="desktop"
          kind="series"
          catalog={env.catalog}
          sources={sources}
          refreshToken={1}
          onPlay={onPlay}
          onOpenSources={jest.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText('Synthetic Series One')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('browse-items-list-row-0'));

      await waitFor(() => {
        expect(screen.getByTestId('series-retry-seasons')).toBeTruthy();
      });
      expect(screen.getByText('Could not reach the server.')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('series-retry-seasons'));

      await waitFor(() => {
        expect(screen.getByText('Season 1 (2)')).toBeTruthy();
        expect(screen.getByText('Season 2 (1)')).toBeTruthy();
        expect(screen.getByText('E1 · Pilot')).toBeTruthy();
        expect(screen.getByText('E2 · Second')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('series-episodes-list-row-0'));

      expect(onPlay).toHaveBeenCalledTimes(1);
      expect(onPlay.mock.calls[0]?.[0]).toEqual({
        itemKey: expect.stringContaining(':episode:9001'),
        sourceId: sources[0]?.id,
        title: 'Synthetic Series One — E1 · Pilot',
        kind: 'vod',
      });

      await fireEvent.press(screen.getByTestId('series-seasons-list-row-1'));
      await waitFor(() => {
        expect(screen.getByText('Episode 1')).toBeTruthy();
      });

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('navigates TV D-pad across categories, items, top nav, and Series Episodes -> Seasons -> Series Items on Back', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const keys = createFakeBrowseKeys();
    const env = await openBrowseTestCatalog({ liveCount: 3 });

    try {
      const sources = await env.addAndImport('Demo');
      const onFocusTopNav = jest.fn();
      const onPlay = jest.fn<void, [PlayTarget]>();

      const view = await render(
        <StatefulSeriesBrowse
          formFactor="tv"
          androidKeys={keys.source}
          kind="series"
          catalog={env.catalog}
          sources={sources}
          refreshToken={1}
          onPlay={onPlay}
          onOpenSources={jest.fn()}
          onFocusTopNav={onFocusTopNav}
          isActiveScope
        />,
      );

      await waitFor(() => {
        expect(screen.getByText('Synthetic Series Two')).toBeTruthy();
      });

      expect(screen.getByTestId('browse-categories-list-ring')).toBeTruthy();
      expect(screen.queryByTestId('browse-items-list-ring')).toBeNull();

      await act(async () => {
        keys.tap(KEYCODE_DPAD_UP);
      });
      expect(onFocusTopNav).toHaveBeenCalledTimes(1);

      await act(async () => {
        keys.tap(KEYCODE_BACK);
      });
      expect(onFocusTopNav).toHaveBeenCalledTimes(2);

      await act(async () => {
        keys.tap(KEYCODE_DPAD_RIGHT);
      });
      expect(screen.getByTestId('browse-items-list-ring')).toBeTruthy();

      await act(async () => {
        keys.tap(KEYCODE_DPAD_LEFT);
      });
      expect(screen.getByTestId('browse-categories-list-ring')).toBeTruthy();

      await act(async () => {
        keys.tap(KEYCODE_DPAD_CENTER);
        keys.tap(KEYCODE_DPAD_DOWN);
      });
      expect(screen.getByTestId('browse-items-list-row-1').props.accessibilityState.selected).toBe(
        true,
      );

      await act(async () => {
        keys.tap(KEYCODE_DPAD_CENTER);
      });

      await waitFor(() => {
        expect(screen.getByText('Season 1 (2)')).toBeTruthy();
        expect(screen.getByText('E1 · Pilot')).toBeTruthy();
      });
      expect(screen.getByTestId('series-seasons-list-ring')).toBeTruthy();

      await act(async () => {
        keys.tap(KEYCODE_DPAD_CENTER);
      });
      expect(screen.getByTestId('series-episodes-list-ring')).toBeTruthy();

      await act(async () => {
        keys.tap(KEYCODE_BACK);
      });
      expect(screen.getByTestId('series-seasons-list-ring')).toBeTruthy();
      expect(screen.queryByTestId('series-episodes-list-ring')).toBeNull();

      await act(async () => {
        keys.tap(KEYCODE_BACK);
      });
      await waitFor(() => {
        expect(screen.getByTestId('browse-items-list-ring')).toBeTruthy();
      });
      expect(screen.getByTestId('browse-items-list-row-1').props.accessibilityState.selected).toBe(
        true,
      );

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });

  it('steps single-pane on phone: categories -> items -> series seasons -> episodes and back', async () => {
    const env = await openBrowseTestCatalog({ liveCount: 2 });
    try {
      const sources = await env.addAndImport('Demo');

      const view = await render(
        <StatefulSeriesBrowse
          formFactor="phone"
          kind="series"
          catalog={env.catalog}
          sources={sources}
          refreshToken={1}
          onPlay={jest.fn()}
          onOpenSources={jest.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText('Shows (2)')).toBeTruthy();
      });
      expect(screen.queryByTestId('browse-items-list')).toBeNull();

      await fireEvent.press(screen.getByTestId('browse-categories-list-row-0'));

      await waitFor(() => {
        expect(screen.getByTestId('browse-back-categories')).toBeTruthy();
        expect(screen.getByText('Synthetic Series One')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('browse-items-list-row-0'));

      await waitFor(() => {
        expect(screen.getByTestId('series-back-series')).toBeTruthy();
        expect(screen.getByText('Season 1 (2)')).toBeTruthy();
      });
      expect(screen.queryByTestId('series-episodes-list')).toBeNull();

      await fireEvent.press(screen.getByTestId('series-seasons-list-row-0'));

      await waitFor(() => {
        expect(screen.getByTestId('series-back-seasons')).toBeTruthy();
        expect(screen.getByText('E1 · Pilot')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('series-back-seasons'));
      expect(screen.getByTestId('series-seasons-list')).toBeTruthy();

      await fireEvent.press(screen.getByTestId('series-back-series'));
      await waitFor(() => {
        expect(screen.getByTestId('browse-back-categories')).toBeTruthy();
      });

      await fireEvent.press(screen.getByTestId('browse-back-categories'));
      expect(screen.getByTestId('browse-categories-list')).toBeTruthy();

      await view.unmount();
    } finally {
      await env.cleanup();
    }
  });
});
