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
});
