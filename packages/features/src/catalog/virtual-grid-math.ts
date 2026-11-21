type VirtualGridScrollAlign = 'start' | 'center' | 'nearest';

/** Inputs for {@link computeVirtualGridScrollOffset}. */
export interface VirtualGridScrollOffsetInput {
  readonly rowIndex: number;
  readonly rowStride: number;
  readonly paddingTop?: number;
  readonly borderTopWidth?: number;
  readonly viewportHeight?: number;
  readonly currentOffset?: number;
  readonly align?: VirtualGridScrollAlign;
}

/** Inputs for {@link computeVirtualGridRowFromOffset}. */
export interface VirtualGridRowFromOffsetInput {
  readonly scrollOffset: number;
  readonly rowStride: number;
  readonly paddingTop?: number;
  readonly borderTopWidth?: number;
}

function nonNegativeFinite(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function clampNonNegative(value: number): number {
  return Math.max(0, value);
}

/**
 * Computes the exact vertical scroll offset for `rowIndex` inside a fixed-stride virtualized grid,
 * accounting for container `paddingTop` and `borderTopWidth` and supporting `'start'`, `'center'`,
 * and `'nearest'` alignment modes (#166).
 */
export function computeVirtualGridScrollOffset({
  rowIndex,
  rowStride,
  paddingTop,
  borderTopWidth,
  viewportHeight,
  currentOffset,
  align = 'start',
}: VirtualGridScrollOffsetInput): number {
  const stride = nonNegativeFinite(rowStride);
  if (stride === 0) return 0;

  const index = Number.isFinite(rowIndex) && rowIndex > 0 ? Math.floor(rowIndex) : 0;
  const leadingInset = nonNegativeFinite(paddingTop) + nonNegativeFinite(borderTopWidth);
  const rowTop = leadingInset + index * stride;
  const viewport = nonNegativeFinite(viewportHeight);

  if (align === 'center' && viewport > 0) {
    return clampNonNegative(rowTop - (viewport - stride) / 2);
  }

  if (align === 'nearest' && viewport > 0) {
    const scrollY = nonNegativeFinite(currentOffset);
    const rowBottom = rowTop + stride;
    if (stride >= viewport || rowTop < scrollY) {
      return clampNonNegative(rowTop);
    }
    if (rowBottom > scrollY + viewport) {
      return clampNonNegative(rowBottom - viewport);
    }
    return clampNonNegative(scrollY);
  }

  return clampNonNegative(rowTop);
}

/**
 * Maps a vertical scroll offset back to the leading row index while subtracting container
 * `paddingTop` and `borderTopWidth` so prefetch and progress hydration stay aligned (#166).
 */
export function computeVirtualGridRowFromOffset({
  scrollOffset,
  rowStride,
  paddingTop,
  borderTopWidth,
}: VirtualGridRowFromOffsetInput): number {
  const stride = nonNegativeFinite(rowStride);
  if (stride === 0) return 0;

  const leadingInset = nonNegativeFinite(paddingTop) + nonNegativeFinite(borderTopWidth);
  const adjustedY = clampNonNegative(nonNegativeFinite(scrollOffset) - leadingInset);
  return Math.floor(adjustedY / stride);
}
