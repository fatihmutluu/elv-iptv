import { computeBrowseRowHeight } from '../BrowseParts';

describe('computeBrowseRowHeight (#62)', () => {
  it('scales TV and pointer browse row heights deterministically at fontScale = 1.2 without shrinking or NaN', () => {
    expect(computeBrowseRowHeight(true, 1.0)).toBe(50);
    expect(computeBrowseRowHeight(true, 1.2)).toBe(60);
    expect(computeBrowseRowHeight(false, 1.0)).toBe(44);
    expect(computeBrowseRowHeight(false, 1.2)).toBe(53);
    expect(computeBrowseRowHeight(true, 0.9)).toBe(50);
    expect(computeBrowseRowHeight(true, Number.NaN)).toBe(50);
  });
});
