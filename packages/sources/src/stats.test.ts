import { describe, expect, it } from 'vitest';
import { createStats, warn } from './stats';

describe('stats', () => {
  it('starts zeroed', () => {
    expect(createStats()).toEqual({ lines: 0, entries: 0, skipped: 0, warnings: [] });
  });

  it('caps warnings at 100 while skipped keeps counting', () => {
    const stats = createStats();
    for (let i = 1; i <= 150; i++) {
      warn(stats, 'bad', i);
      stats.skipped++;
    }
    expect(stats.warnings).toHaveLength(100);
    expect(stats.warnings[99]).toEqual({ code: 'bad', line: 100 });
    expect(stats.skipped).toBe(150);
  });
});
