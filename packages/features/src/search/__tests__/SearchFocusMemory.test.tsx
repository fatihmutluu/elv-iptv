import type { KeyEvent } from '@elv/focus-core';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { BrowseFocusMemoryProvider, createBrowseFocusMemory } from '../../shared';
import { useTvSearchNavigation } from '../useTvSearchNavigation';

const press = (key: KeyEvent['key']): KeyEvent => ({ key, kind: 'press', time: 100 });

describe('useTvSearchNavigation focus preservation (#440)', () => {
  it('preserves Search TV focus position across playback unmount/remount', async () => {
    const memory = createBrowseFocusMemory();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <BrowseFocusMemoryProvider memory={memory}>{children}</BrowseFocusMemoryProvider>
    );
    const rows = [
      { id: 'input' as const, count: 2 },
      { id: 'scopes' as const, count: 4 },
      { id: 'live' as const, count: 4, columns: 3 },
    ];

    const first = await renderHook(
      () =>
        useTvSearchNavigation({
          isTv: true,
          isActiveScope: true,
          hasQuery: true,
          rows,
          onActivate: jest.fn(),
          onClearSearch: jest.fn(),
        }),
      { wrapper },
    );

    await act(async () => {
      first.result.current.handleTvKey(press('down'));
      first.result.current.handleTvKey(press('down'));
      first.result.current.handleTvKey(press('right'));
    });
    expect(first.result.current.focusedRowId).toBe('live');
    expect(first.result.current.focusedCol).toBe(1);
    await first.unmount();

    const second = await renderHook(
      () =>
        useTvSearchNavigation({
          isTv: true,
          isActiveScope: true,
          hasQuery: true,
          rows,
          onActivate: jest.fn(),
          onClearSearch: jest.fn(),
        }),
      { wrapper },
    );
    expect(second.result.current.focusedRowId).toBe('live');
    expect(second.result.current.focusedCol).toBe(1);
    await second.unmount();
  });
});
