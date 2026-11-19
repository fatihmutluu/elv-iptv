import { describe, expect, it, vi } from 'vitest';
import { createPlaybackGuard, noopPlaybackGuard } from './index';

describe('createPlaybackGuard (#67)', () => {
  it('stops matching registered sessions synchronously before invoking onStopSource', () => {
    const order: string[] = [];
    const guard = createPlaybackGuard((id) => order.push(`ui:${id}`));
    const unregisterA = guard.registerSession?.({
      getSourceId: () => 'src-a',
      stop: () => order.push('stop:a'),
    });
    guard.registerSession?.({
      getSourceId: () => 'src-b',
      stop: () => order.push('stop:b'),
    });

    guard.stopIfUsingSource('src-a');
    expect(order).toEqual(['stop:a', 'ui:src-a']);

    order.length = 0;
    unregisterA?.();
    guard.stopIfUsingSource('src-a');
    expect(order).toEqual(['ui:src-a']);

    const noopUnreg = noopPlaybackGuard.registerSession?.({
      getSourceId: () => 'x',
      stop: vi.fn(),
    });
    noopUnreg?.();
    expect(noopPlaybackGuard.stopIfUsingSource('x')).toBeUndefined();
  });
});
