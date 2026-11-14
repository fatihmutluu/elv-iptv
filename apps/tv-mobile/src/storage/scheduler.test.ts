import { describe, expect, it } from 'vitest';
import { createMacrotaskScheduler } from './scheduler';

describe('createMacrotaskScheduler', () => {
  it('yields a macrotask before resolving', async () => {
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);
    await createMacrotaskScheduler().yieldNow();
    order.push('resolved');
    expect(order).toEqual(['timer', 'resolved']);
  });
});
