import { createSyntheticSource } from '../list-source';

describe('createSyntheticSource', () => {
  it('computes on demand and returns undefined out of range', () => {
    const make = jest.fn((i: number) => ({ i }));
    const s = createSyntheticSource(100_000, make);
    expect(s.count()).toBe(100_000);
    expect(make).not.toHaveBeenCalled();
    expect(s.get(5)).toEqual({ i: 5 });
    expect(s.get(5)).toBe(s.get(5));
    expect(make).toHaveBeenCalledTimes(1);
    expect(s.get(-1)).toBeUndefined();
    expect(s.get(100_000)).toBeUndefined();
  });

  it('keeps a small LRU', () => {
    const make = jest.fn((i: number) => ({ i }));
    const s = createSyntheticSource(1000, make, 4);
    for (let i = 0; i < 10; i++) s.get(i);
    make.mockClear();
    s.get(9);
    expect(make).not.toHaveBeenCalled();
    s.get(0);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('supports prefetch and change listeners without errors', () => {
    const s = createSyntheticSource(10, (i) => i);
    s.prefetch(0, 5);
    const off = s.onChange(() => {});
    off();
  });
});
