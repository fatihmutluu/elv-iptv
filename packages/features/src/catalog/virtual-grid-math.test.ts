import { describe, expect, it } from 'vitest';
import {
  computeVirtualGridRowFromOffset,
  computeVirtualGridScrollOffset,
} from './virtual-grid-math';

describe('computeVirtualGridScrollOffset', () => {
  it('computes start offset including paddingTop and borderTopWidth', () => {
    expect(
      computeVirtualGridScrollOffset({
        rowIndex: 0,
        rowStride: 240,
        paddingTop: 16,
        borderTopWidth: 2,
      }),
    ).toBe(18);

    expect(
      computeVirtualGridScrollOffset({
        rowIndex: 4,
        rowStride: 240,
        paddingTop: 16,
        borderTopWidth: 2,
      }),
    ).toBe(978);
  });

  it('defaults paddingTop and borderTopWidth to 0 and clamps invalid/negative inputs to >= 0', () => {
    expect(computeVirtualGridScrollOffset({ rowIndex: 3, rowStride: 200 })).toBe(600);
    expect(
      computeVirtualGridScrollOffset({
        rowIndex: -4,
        rowStride: 200,
        paddingTop: -10,
        borderTopWidth: Number.NaN,
      }),
    ).toBe(0);
    expect(computeVirtualGridScrollOffset({ rowIndex: 5, rowStride: 0 })).toBe(0);
    expect(computeVirtualGridScrollOffset({ rowIndex: 5, rowStride: -100 })).toBe(0);
  });

  it('centers the row within viewportHeight when align is center and clamps top rows at 0', () => {
    // Row 0 top = 20, height = 200, viewport = 800 -> 20 - (800 - 200)/2 = -280 -> clamped to 0
    expect(
      computeVirtualGridScrollOffset({
        rowIndex: 0,
        rowStride: 200,
        paddingTop: 16,
        borderTopWidth: 4,
        viewportHeight: 800,
        align: 'center',
      }),
    ).toBe(0);

    // Row 5 top = 20 + 1000 = 1020, centered in 800 -> 1020 - 300 = 720
    expect(
      computeVirtualGridScrollOffset({
        rowIndex: 5,
        rowStride: 200,
        paddingTop: 16,
        borderTopWidth: 4,
        viewportHeight: 800,
        align: 'center',
      }),
    ).toBe(720);

    // Without viewportHeight, falls back to start offset
    expect(
      computeVirtualGridScrollOffset({
        rowIndex: 5,
        rowStride: 200,
        paddingTop: 16,
        borderTopWidth: 4,
        align: 'center',
      }),
    ).toBe(1020);
  });

  it('handles nearest alignment relative to currentOffset and viewportHeight', () => {
    // Row 2 occupies [420, 620] with paddingTop=16, borderTopWidth=4, stride=200
    // Already fully visible inside [300, 900] -> keep currentOffset = 300
    expect(
      computeVirtualGridScrollOffset({
        rowIndex: 2,
        rowStride: 200,
        paddingTop: 16,
        borderTopWidth: 4,
        viewportHeight: 600,
        currentOffset: 300,
        align: 'nearest',
      }),
    ).toBe(300);

    // Above viewport (currentOffset = 500 -> visible [500, 1100]) -> scroll up to rowTop = 420
    expect(
      computeVirtualGridScrollOffset({
        rowIndex: 2,
        rowStride: 200,
        paddingTop: 16,
        borderTopWidth: 4,
        viewportHeight: 600,
        currentOffset: 500,
        align: 'nearest',
      }),
    ).toBe(420);

    // Below viewport (currentOffset = 0 -> visible [0, 600]) -> scroll down to 620 - 600 = 20
    expect(
      computeVirtualGridScrollOffset({
        rowIndex: 2,
        rowStride: 200,
        paddingTop: 16,
        borderTopWidth: 4,
        viewportHeight: 600,
        currentOffset: 0,
        align: 'nearest',
      }),
    ).toBe(20);

    // Row taller than viewport -> align to rowTop
    expect(
      computeVirtualGridScrollOffset({
        rowIndex: 2,
        rowStride: 400,
        paddingTop: 10,
        borderTopWidth: 2,
        viewportHeight: 300,
        currentOffset: 100,
        align: 'nearest',
      }),
    ).toBe(812);
  });
});

describe('computeVirtualGridRowFromOffset', () => {
  it('maps scroll content offset back to top row index subtracting paddingTop + borderTopWidth', () => {
    expect(
      computeVirtualGridRowFromOffset({
        scrollOffset: 15,
        rowStride: 200,
        paddingTop: 16,
        borderTopWidth: 4,
      }),
    ).toBe(0);

    expect(
      computeVirtualGridRowFromOffset({
        scrollOffset: 220,
        rowStride: 200,
        paddingTop: 16,
        borderTopWidth: 4,
      }),
    ).toBe(1);

    expect(
      computeVirtualGridRowFromOffset({
        scrollOffset: 619,
        rowStride: 200,
        paddingTop: 16,
        borderTopWidth: 4,
      }),
    ).toBe(2);

    expect(computeVirtualGridRowFromOffset({ scrollOffset: 500, rowStride: 0 })).toBe(0);
  });
});
