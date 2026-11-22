import type { KeyEvent } from '@elv/focus-core';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { BrowseFocusMemoryProvider, createBrowseFocusMemory } from '../../shared';
import { useTvDetailNavigation } from '../useTvDetailNavigation';

const press = (key: KeyEvent['key']): KeyEvent => ({ key, kind: 'press', time: 100 });

describe('useTvDetailNavigation focus preservation (#440)', () => {
  it('preserves Detail TV focus per detail:<itemKey> while fresh targets start on hero-play', async () => {
    const memory = createBrowseFocusMemory();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <BrowseFocusMemoryProvider memory={memory}>{children}</BrowseFocusMemoryProvider>
    );
    const rows = [
      { id: 'back' as const, count: 1, orientation: 'horizontal' as const },
      { id: 'hero-play' as const, count: 1, orientation: 'horizontal' as const },
      { id: 'episodes' as const, count: 5, orientation: 'vertical' as const },
    ];

    const first = await renderHook(
      () =>
        useTvDetailNavigation({
          isTv: true,
          isActiveScope: true,
          targetKey: 'series:42',
          rows,
          onActivate: jest.fn(),
          onBack: jest.fn(),
        }),
      { wrapper },
    );

    await act(async () => {
      first.result.current.handleTvKey(press('down'));
      first.result.current.handleTvKey(press('down'));
      first.result.current.handleTvKey(press('down'));
    });
    expect(first.result.current.focusedRowId).toBe('episodes');
    expect(first.result.current.focusedCol).toBe(2);
    await first.unmount();

    const restored = await renderHook(
      () =>
        useTvDetailNavigation({
          isTv: true,
          isActiveScope: true,
          targetKey: 'series:42',
          rows,
          onActivate: jest.fn(),
          onBack: jest.fn(),
        }),
      { wrapper },
    );
    expect(restored.result.current.focusedRowId).toBe('episodes');
    expect(restored.result.current.focusedCol).toBe(2);
    await restored.unmount();

    const fresh = await renderHook(
      () =>
        useTvDetailNavigation({
          isTv: true,
          isActiveScope: true,
          targetKey: 'series:99',
          rows,
          onActivate: jest.fn(),
          onBack: jest.fn(),
        }),
      { wrapper },
    );
    expect(fresh.result.current.focusedRowId).toBe('hero-play');
    expect(fresh.result.current.focusedCol).toBe(0);
    await fresh.unmount();
  });

  it('keeps pending focus token alive across async seasons/episodes hydration and cancels on manual input (#112)', async () => {
    const memory = createBrowseFocusMemory();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <BrowseFocusMemoryProvider memory={memory}>{children}</BrowseFocusMemoryProvider>
    );
    const fullRows = [
      { id: 'back' as const, count: 1, orientation: 'horizontal' as const },
      { id: 'hero-actions' as const, count: 2, orientation: 'horizontal' as const },
      { id: 'hero-play' as const, count: 1, orientation: 'horizontal' as const },
      { id: 'seasons' as const, count: 3, orientation: 'horizontal' as const },
      { id: 'episodes' as const, count: 5, orientation: 'vertical' as const },
    ];
    const skeletonRows = fullRows.slice(0, 3);
    const seasonsOnlyRows = fullRows.slice(0, 4);

    // First visit: navigate to episodes[2] so focus memory records it
    const first = await renderHook(
      () =>
        useTvDetailNavigation({
          isTv: true,
          isActiveScope: true,
          targetKey: 'series:42',
          rows: fullRows,
          onActivate: jest.fn(),
          onBack: jest.fn(),
        }),
      { wrapper },
    );
    await act(async () => {
      first.result.current.handleTvKey(press('down')); // seasons
      first.result.current.handleTvKey(press('down')); // episodes[0]
      first.result.current.handleTvKey(press('down')); // episodes[1]
      first.result.current.handleTvKey(press('down')); // episodes[2]
    });
    expect(first.result.current.focusedRowId).toBe('episodes');
    expect(first.result.current.focusedCol).toBe(2);
    await first.unmount();

    // Return while seasons & episodes are still hydrating asynchronously
    const hydrated = await renderHook(
      ({ rows }: { rows: typeof fullRows }) =>
        useTvDetailNavigation({
          isTv: true,
          isActiveScope: true,
          targetKey: 'series:42',
          rows,
          onActivate: jest.fn(),
          onBack: jest.fn(),
        }),
      { wrapper, initialProps: { rows: skeletonRows } },
    );
    expect(hydrated.result.current.focusedRowId).toBe('hero-play');

    // Intermediate render: seasons arrive, episodes still loading -> pending token stays alive
    await hydrated.rerender({ rows: seasonsOnlyRows });
    expect(hydrated.result.current.focusedRowId).toBe('hero-play');

    // Final render: episodes arrive -> pending token restores episodes[2]
    await hydrated.rerender({ rows: fullRows });
    expect(hydrated.result.current.focusedRowId).toBe('episodes');
    expect(hydrated.result.current.focusedCol).toBe(2);
    await hydrated.unmount();

    // Return again, but user manually navigates horizontally on hero-actions before episodes load -> cancels pending token!
    const manual = await renderHook(
      ({ rows }: { rows: typeof fullRows }) =>
        useTvDetailNavigation({
          isTv: true,
          isActiveScope: true,
          targetKey: 'series:42',
          rows,
          onActivate: jest.fn(),
          onBack: jest.fn(),
        }),
      { wrapper, initialProps: { rows: skeletonRows } },
    );
    await act(async () => {
      manual.result.current.handleTvKey(press('up')); // hero-actions[0]
      manual.result.current.handleTvKey(press('right')); // hero-actions[1]
    });
    expect(manual.result.current.focusedRowId).toBe('hero-actions');
    expect(manual.result.current.focusedCol).toBe(1);

    // Episodes arrive later -> must NOT hijack focus back to episodes[2]
    await manual.rerender({ rows: fullRows });
    expect(manual.result.current.focusedRowId).toBe('hero-actions');
    expect(manual.result.current.focusedCol).toBe(1);
    await manual.unmount();

    // Also verify horizontal input on initial row (without changing row) cancels pending token
    const horizontalRows = [
      { id: 'back' as const, count: 1, orientation: 'horizontal' as const },
      { id: 'hero-play' as const, count: 2, orientation: 'horizontal' as const },
    ];
    memory.set('detail:series:77', {
      rowId: 'episodes',
      col: 3,
      colByRow: { episodes: 3 },
    });
    const horiz = await renderHook(
      ({ rows }: { rows: typeof fullRows }) =>
        useTvDetailNavigation({
          isTv: true,
          isActiveScope: true,
          targetKey: 'series:77',
          rows,
          onActivate: jest.fn(),
          onBack: jest.fn(),
        }),
      { wrapper, initialProps: { rows: horizontalRows } },
    );
    await act(async () => {
      horiz.result.current.handleTvKey(press('right')); // manual horizontal move on hero-play
    });
    expect(horiz.result.current.focusedRowId).toBe('hero-play');
    expect(horiz.result.current.focusedCol).toBe(1);

    await horiz.rerender({
      rows: [
        ...horizontalRows,
        { id: 'episodes' as const, count: 5, orientation: 'vertical' as const },
      ],
    });
    expect(horiz.result.current.focusedRowId).toBe('hero-play');
    expect(horiz.result.current.focusedCol).toBe(1);
    await horiz.unmount();
  });
});
