import type { CatalogService } from '@elv/data';
import { createMemoryPreferencesStore, ok } from '@elv/domain';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import { AppProviders, AppShell } from '../index';

describe('AppShell player OSD auto-hide default (#421)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('#421: AppShell mounts PlayerScreen with default 3500ms OSD auto-hide during playback', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const now = () => Date.now();
    const engine = createFakePlayerEngine({
      now,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const stubCatalog = {
      listSources: async () => [
        {
          id: 'src-1',
          kind: 'm3u',
          name: 'Sim',
          createdAt: 1,
          lastSyncAt: 1,
          lastError: null,
        },
      ],
      categories: async (_s: string, kind: string) =>
        kind === 'live'
          ? [
              {
                id: 'c1',
                sourceId: 'src-1',
                kind: 'live',
                name: 'General',
                itemCount: 1,
                sortOrder: 0,
              },
            ]
          : [],
      items: async () => [
        {
          key: 'ch:1',
          sourceId: 'src-1',
          categoryId: 'c1',
          kind: 'live',
          name: 'Channel 1',
          channelNum: 1,
          sortOrder: 0,
        },
      ],
      resolveStream: async () => ok({ url: 'http://sim.example.test/1.ts', headers: {} }),
    } as unknown as CatalogService;

    const view = await render(
      <AppProviders preferencesStore={createMemoryPreferencesStore()} systemLocale="en">
        <AppShell
          catalog={stubCatalog}
          videoHost={{
            open: () => ({ engine, renderSurface: () => <View testID="fake-surface" /> }),
          }}
        />
      </AppProviders>,
    );

    const card = await screen.findByTestId('home-live-item-0');
    await fireEvent.press(card);

    await waitFor(() => {
      expect(engine.commands.some((c) => c.name === 'load')).toBe(true);
    });
    const attempt = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      engine.emit({ attempt, type: 'firstFrame', atMs: now() });
      engine.emit({ attempt, type: 'state', state: 'playing' });
    });
    expect(screen.getByTestId('player-osd')).toBeTruthy();

    await act(async () => {
      jest.advanceTimersByTime(3_499);
    });
    expect(screen.getByTestId('player-osd')).toBeTruthy();
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('player-osd')).toBeNull();

    await view.unmount();
  });
});
