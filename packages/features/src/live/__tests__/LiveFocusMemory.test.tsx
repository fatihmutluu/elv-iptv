import type { ItemRow } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import { createAppI18n } from '@elv/i18n';
import {
  type AndroidKeyEvent,
  type AndroidKeySource,
  buildTheme,
  FormFactorProvider,
  I18nProvider,
  RemoteKeysProvider,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { act, render, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import {
  BrowseFocusMemoryProvider,
  computeCatalogLayout,
  createBrowseFocusMemory,
  createPagedListSource,
} from '../../shared';
import { LiveChannelsGrid } from '../LiveChannelsGrid';
import { useTvLiveNavigation } from '../useTvLiveNavigation';

const press = (key: KeyEvent['key']): KeyEvent => ({ key, kind: 'press', time: 100 });

describe('Live TV focus preservation (#440)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preserves Live TV zone/category/mode focus across playback exit (including async hasBody)', async () => {
    const memory = createBrowseFocusMemory();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <BrowseFocusMemoryProvider memory={memory}>{children}</BrowseFocusMemoryProvider>
    );
    const baseOpts = {
      isTv: true,
      isActiveScope: true,
      isEmpty: false,
      hasOpenSourcesCta: false,
      mode: 'channels' as const,
      categoryCount: 3,
      channelCount: 10,
      hasBody: true,
      zapDrawerOpen: false,
      numpadOpen: false,
      onSelectMode: jest.fn(),
      onSelectCategoryIndex: jest.fn(),
      onToggleNumpad: jest.fn(),
      onCloseNumpad: jest.fn(),
      onPressNumpadKey: jest.fn(),
      onActivateWatchControl: jest.fn(),
      onSelectZapIndex: jest.fn(),
      onOpenSources: jest.fn(),
    };

    const first = await renderHook(() => useTvLiveNavigation(baseOpts), { wrapper });
    await act(async () => {
      first.result.current.handleTvKey(press('down'));
      first.result.current.handleTvKey(press('right'));
      first.result.current.handleTvKey(press('down'));
    });
    expect(first.result.current.tvZone).toBe('body');
    await first.unmount();

    const second = await renderHook(
      ({ hasBody }: { hasBody: boolean }) => useTvLiveNavigation({ ...baseOpts, hasBody }),
      { wrapper, initialProps: { hasBody: false } },
    );
    await second.rerender({ hasBody: true });
    expect(second.result.current.tvZone).toBe('body');
    await second.unmount();
  });

  it('preserves LiveChannelsGrid TV (row, col) focus across unmount/remount', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const listeners = new Set<(e: AndroidKeyEvent) => void>();
    const androidSource: AndroidKeySource = {
      addListener: (l) => {
        listeners.add(l);
        return { remove: () => listeners.delete(l) };
      },
    };
    const tapKey = (keyCode: number) => {
      for (const l of listeners) {
        l({ action: 'down', keyCode, canceled: false, ageMs: 0 });
        l({ action: 'up', keyCode, canceled: false, ageMs: 0 });
      }
    };
    const items: ItemRow[] = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      key: `ch:${i}`,
      sourceId: 'src-1',
      categoryId: 'cat-1',
      providerId: String(100 + i),
      kind: 'live',
      name: `Channel ${i + 1}`,
      num: i + 1,
      channelNum: i + 1,
      logo: null,
      rating: null,
      year: null,
      addedAt: null,
      sortOrder: i,
    }));
    const source = createPagedListSource<ItemRow>({
      count: items.length,
      pageSize: 10,
      loadPage: async (offset, limit) => items.slice(offset, offset + limit),
    });
    await source.loadItem(0);
    const memory = createBrowseFocusMemory();
    const layout = computeCatalogLayout(
      {
        formFactor: 'tv',
        orientation: 'landscape',
        inputModality: 'tv',
        width: 1280,
        height: 720,
        safeArea: { top: 0, bottom: 0, left: 0, right: 0 },
        overscan: { x: 48, y: 27 },
        columns: { posterRail: 6.4, wideRail: 4.3, categoryGrid: 6 },
        tvScale: 1,
      },
      buildTheme({ preset: 'obsidianCrimson' }),
    );
    const onWatchChannel = jest.fn();
    const renderGrid = () => (
      <ThemeProvider preset="obsidianCrimson">
        <RemoteKeysProvider android={androidSource}>
          <ViewportProvider
            value={{ width: 1280, height: 720, formFactor: 'tv', orientation: 'landscape' }}
          >
            <FormFactorProvider value="tv">
              <I18nProvider i18n={createAppI18n('en')}>
                <BrowseFocusMemoryProvider memory={memory}>
                  <LiveChannelsGrid
                    channelSource={source}
                    sourceVersion={1}
                    nowNextByKey={new Map()}
                    nowNextVersion={0}
                    activeChannelKey={null}
                    layout={layout}
                    hydrateNowNext={jest.fn()}
                    onWatchChannel={onWatchChannel}
                    isActiveScope
                  />
                </BrowseFocusMemoryProvider>
              </I18nProvider>
            </FormFactorProvider>
          </ViewportProvider>
        </RemoteKeysProvider>
      </ThemeProvider>
    );

    const first = await render(renderGrid());
    await act(async () => {
      tapKey(20);
      tapKey(22);
    });
    await first.unmount();

    const second = await render(renderGrid());
    await act(async () => {
      tapKey(23);
    });
    expect(onWatchChannel).toHaveBeenCalledWith(items[4], 4);
    await second.unmount();
  });
});
