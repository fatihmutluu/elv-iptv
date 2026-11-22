import type { KeyEvent } from '@elv/focus-core';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { BrowseFocusMemoryProvider, createBrowseFocusMemory } from '../../shared';
import { useTvCatalogNavigation } from '../useTvCatalogNavigation';

const press = (key: KeyEvent['key']): KeyEvent => ({ key, kind: 'press', time: 100 });

describe('useTvCatalogNavigation focus preservation (#440)', () => {
  it('preserves CatalogDiscovery TV rail focus per kind across unmount/remount', async () => {
    const memory = createBrowseFocusMemory();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <BrowseFocusMemoryProvider memory={memory}>{children}</BrowseFocusMemoryProvider>
    );
    const rows = [
      { id: 'catChips' as const, count: 4 },
      { id: 'rail-0' as const, count: 6 },
      { id: 'rail-1' as const, count: 6 },
    ];

    const first = await renderHook(
      () =>
        useTvCatalogNavigation({
          focusMemoryKey: 'movie',
          isTv: true,
          isActiveScope: true,
          isGridMode: false,
          rows,
          gridColumns: 6,
          gridItemCount: 0,
          onActivateRow: jest.fn(),
          onActivateGridItem: jest.fn(),
          onExitGrid: jest.fn(),
        }),
      { wrapper },
    );

    await act(async () => {
      first.result.current.handleTvKey(press('down'));
      first.result.current.handleTvKey(press('down'));
      first.result.current.handleTvKey(press('right'));
      first.result.current.handleTvKey(press('right'));
      first.result.current.handleTvKey(press('right'));
    });
    expect(first.result.current.focusedRowId).toBe('rail-1');
    expect(first.result.current.focusedCol).toBe(3);
    await first.unmount();

    const second = await renderHook(
      () =>
        useTvCatalogNavigation({
          focusMemoryKey: 'movie',
          isTv: true,
          isActiveScope: true,
          isGridMode: false,
          rows,
          gridColumns: 6,
          gridItemCount: 0,
          onActivateRow: jest.fn(),
          onActivateGridItem: jest.fn(),
          onExitGrid: jest.fn(),
        }),
      { wrapper },
    );
    expect(second.result.current.focusedRowId).toBe('rail-1');
    expect(second.result.current.focusedCol).toBe(3);
    await second.unmount();
  });
});
