import type { KeyEvent } from '@elv/focus-core';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { BrowseFocusMemoryProvider, createBrowseFocusMemory } from '../../shared';
import { useTvHomeNavigation } from '../useTvHomeNavigation';

const press = (key: KeyEvent['key']): KeyEvent => ({ key, kind: 'press', time: 100 });

describe('useTvHomeNavigation focus preservation (#440)', () => {
  it('preserves Home TV focus row & column across playback unmount/remount', async () => {
    const memory = createBrowseFocusMemory();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <BrowseFocusMemoryProvider memory={memory}>{children}</BrowseFocusMemoryProvider>
    );
    const rows = [
      { id: 'hero' as const, count: 2 },
      { id: 'live' as const, count: 4 },
      { id: 'movies' as const, count: 5 },
    ];

    const first = await renderHook(
      () =>
        useTvHomeNavigation({
          isTv: true,
          isActiveScope: true,
          rows,
          onActivate: jest.fn(),
        }),
      { wrapper },
    );

    await act(async () => {
      first.result.current.handleTvKey(press('down'));
      first.result.current.handleTvKey(press('down'));
      first.result.current.handleTvKey(press('right'));
      first.result.current.handleTvKey(press('right'));
    });
    expect(first.result.current.focusedRowId).toBe('movies');
    expect(first.result.current.focusedCol).toBe(2);
    await first.unmount();

    const second = await renderHook(
      () =>
        useTvHomeNavigation({
          isTv: true,
          isActiveScope: true,
          rows,
          onActivate: jest.fn(),
        }),
      { wrapper },
    );
    expect(second.result.current.focusedRowId).toBe('movies');
    expect(second.result.current.focusedCol).toBe(2);
    await second.unmount();
  });

  it('retains pending restore across partial cached rows until target rail arrives asynchronously', async () => {
    const memory = createBrowseFocusMemory();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <BrowseFocusMemoryProvider memory={memory}>{children}</BrowseFocusMemoryProvider>
    );
    const fullRows = [
      { id: 'hero' as const, count: 2 },
      { id: 'live' as const, count: 4 },
      { id: 'movies' as const, count: 5 },
    ];
    const partialRows = [
      { id: 'hero' as const, count: 2 },
      { id: 'live' as const, count: 4 },
    ];

    const first = await renderHook(
      () =>
        useTvHomeNavigation({
          isTv: true,
          isActiveScope: true,
          rows: fullRows,
          onActivate: jest.fn(),
        }),
      { wrapper },
    );
    await act(async () => {
      first.result.current.handleTvKey(press('down'));
      first.result.current.handleTvKey(press('down'));
      first.result.current.handleTvKey(press('right'));
      first.result.current.handleTvKey(press('right'));
    });
    expect(first.result.current.focusedRowId).toBe('movies');
    expect(first.result.current.focusedCol).toBe(2);
    await first.unmount();

    // Remount with partial cached rows first (movies not yet loaded), then async movies arrives
    const second = await renderHook(
      ({ rows }: { rows: typeof fullRows }) =>
        useTvHomeNavigation({
          isTv: true,
          isActiveScope: true,
          rows,
          onActivate: jest.fn(),
        }),
      { wrapper, initialProps: { rows: partialRows } },
    );
    expect(second.result.current.focusedRowId).toBe('hero');

    await second.rerender({ rows: fullRows });
    expect(second.result.current.focusedRowId).toBe('movies');
    expect(second.result.current.focusedCol).toBe(2);
    await second.unmount();
  });

  it('cancels pending async restore when user navigates manually with D-pad first', async () => {
    const memory = createBrowseFocusMemory();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <BrowseFocusMemoryProvider memory={memory}>{children}</BrowseFocusMemoryProvider>
    );
    const fullRows = [
      { id: 'hero' as const, count: 2 },
      { id: 'live' as const, count: 4 },
      { id: 'movies' as const, count: 5 },
    ];
    const partialRows = [
      { id: 'hero' as const, count: 2 },
      { id: 'live' as const, count: 4 },
    ];

    memory.set('home', { rowId: 'movies', col: 3, colByRow: { movies: 3 } });

    const hook = await renderHook(
      ({ rows }: { rows: typeof fullRows }) =>
        useTvHomeNavigation({
          isTv: true,
          isActiveScope: true,
          rows,
          onActivate: jest.fn(),
        }),
      { wrapper, initialProps: { rows: partialRows } },
    );

    // User manually navigates down to live[1] before movies finishes loading
    await act(async () => {
      hook.result.current.handleTvKey(press('down'));
      hook.result.current.handleTvKey(press('right'));
    });
    expect(hook.result.current.focusedRowId).toBe('live');
    expect(hook.result.current.focusedCol).toBe(1);

    // Async movies rail arrives -> must NOT yank focus away from user's manual selection
    await hook.rerender({ rows: fullRows });
    expect(hook.result.current.focusedRowId).toBe('live');
    expect(hook.result.current.focusedCol).toBe(1);
    await hook.unmount();
  });
});
