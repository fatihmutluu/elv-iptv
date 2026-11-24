/** Maximum UTF-8 byte length supported by Version 10 Error Correction Level M in Byte mode. */
export const MAX_QR_PAYLOAD_BYTES = 213;

/** Encoded ISO/IEC 18004 QR Code matrix. */
export interface QrMatrix {
  /** QR version (`1`–`10`). */
  readonly version: number;
  /** Width and height in modules (`17 + 4 * version`). */
  readonly size: number;
  /** Selected mask pattern index (`0`–`7`). */
  readonly mask: number;
  /** Square grid of dark (`true`) and light (`false`) modules. */
  readonly modules: readonly (readonly boolean[])[];
}

interface VersionSpec {
  readonly version: number;
  readonly maxBytes: number;
  readonly totalDataCodewords: number;
  readonly ecPerBlock: number;
  readonly group1Blocks: number;
  readonly group1DataCw: number;
  readonly group2Blocks: number;
  readonly group2DataCw: number;
  readonly alignmentCenters: readonly number[];
}

// ISO/IEC 18004 Table 7 & Table 9 for Versions 1-10 at Error Correction Level M.
const VERSION_SPECS: readonly VersionSpec[] = [
  {
    version: 1,
    maxBytes: 14,
    totalDataCodewords: 16,
    ecPerBlock: 10,
    group1Blocks: 1,
    group1DataCw: 16,
    group2Blocks: 0,
    group2DataCw: 0,
    alignmentCenters: [],
  },
  {
    version: 2,
    maxBytes: 26,
    totalDataCodewords: 28,
    ecPerBlock: 16,
    group1Blocks: 1,
    group1DataCw: 28,
    group2Blocks: 0,
    group2DataCw: 0,
    alignmentCenters: [6, 18],
  },
  {
    version: 3,
    maxBytes: 42,
    totalDataCodewords: 44,
    ecPerBlock: 26,
    group1Blocks: 1,
    group1DataCw: 44,
    group2Blocks: 0,
    group2DataCw: 0,
    alignmentCenters: [6, 22],
  },
  {
    version: 4,
    maxBytes: 62,
    totalDataCodewords: 64,
    ecPerBlock: 18,
    group1Blocks: 2,
    group1DataCw: 32,
    group2Blocks: 0,
    group2DataCw: 0,
    alignmentCenters: [6, 26],
  },
  {
    version: 5,
    maxBytes: 84,
    totalDataCodewords: 86,
    ecPerBlock: 24,
    group1Blocks: 2,
    group1DataCw: 43,
    group2Blocks: 0,
    group2DataCw: 0,
    alignmentCenters: [6, 30],
  },
  {
    version: 6,
    maxBytes: 106,
    totalDataCodewords: 108,
    ecPerBlock: 16,
    group1Blocks: 4,
    group1DataCw: 27,
    group2Blocks: 0,
    group2DataCw: 0,
    alignmentCenters: [6, 34],
  },
  {
    version: 7,
    maxBytes: 122,
    totalDataCodewords: 124,
    ecPerBlock: 18,
    group1Blocks: 4,
    group1DataCw: 31,
    group2Blocks: 0,
    group2DataCw: 0,
    alignmentCenters: [6, 22, 38],
  },
  {
    version: 8,
    maxBytes: 152,
    totalDataCodewords: 154,
    ecPerBlock: 22,
    group1Blocks: 2,
    group1DataCw: 38,
    group2Blocks: 2,
    group2DataCw: 39,
    alignmentCenters: [6, 24, 42],
  },
  {
    version: 9,
    maxBytes: 180,
    totalDataCodewords: 182,
    ecPerBlock: 22,
    group1Blocks: 3,
    group1DataCw: 36,
    group2Blocks: 2,
    group2DataCw: 37,
    alignmentCenters: [6, 26, 46],
  },
  {
    version: 10,
    maxBytes: 213,
    totalDataCodewords: 216,
    ecPerBlock: 26,
    group1Blocks: 4,
    group1DataCw: 43,
    group2Blocks: 1,
    group2DataCw: 44,
    alignmentCenters: [6, 28, 50],
  },
];

// Precompute GF(256) exp/log tables with primitive polynomial 0x11D.
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255] as number;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] as number) + (GF_LOG[b] as number)] as number;
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i] as number;
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] as number) ^ (poly[j] as number);
      next[j + 1] = (next[j + 1] as number) ^ gfMul(poly[j] as number, factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i += 1) {
    const factor = (data[i] as number) ^ (rem[0] as number);
    for (let j = 0; j < ecCount - 1; j += 1) {
      rem[j] = (rem[j + 1] as number) ^ gfMul(gen[j + 1] as number, factor);
    }
    rem[ecCount - 1] = gfMul(gen[ecCount] as number, factor);
  }
  return rem;
}

function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    let code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function buildDataCodewords(payload: Uint8Array, spec: VersionSpec): Uint8Array {
  const bits: number[] = [];
  const pushBits = (val: number, count: number): void => {
    for (let i = count - 1; i >= 0; i -= 1) {
      bits.push((val >>> i) & 1);
    }
  };

  // Byte mode indicator (0100) + length (8 bits for V1-9, 16 bits for V10).
  pushBits(0b0100, 4);
  pushBits(payload.length, spec.version <= 9 ? 8 : 16);
  for (let i = 0; i < payload.length; i += 1) {
    pushBits(payload[i] as number, 8);
  }

  const capacityBits = spec.totalDataCodewords * 8;
  const terminator = Math.min(4, capacityBits - bits.length);
  pushBits(0, terminator);
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const codewords = new Uint8Array(spec.totalDataCodewords);
  const byteCount = bits.length / 8;
  for (let i = 0; i < byteCount; i += 1) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) {
      b = (b << 1) | (bits[i * 8 + j] as number);
    }
    codewords[i] = b;
  }

  for (let i = byteCount; i < spec.totalDataCodewords; i += 1) {
    codewords[i] = (i - byteCount) % 2 === 0 ? 0xec : 0x11;
  }

  return codewords;
}

function buildInterleavedStream(dataCw: Uint8Array, spec: VersionSpec): Uint8Array {
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;

  for (let i = 0; i < spec.group1Blocks; i += 1) {
    const block = dataCw.subarray(offset, offset + spec.group1DataCw);
    dataBlocks.push(block);
    ecBlocks.push(rsComputeRemainder(block, spec.ecPerBlock));
    offset += spec.group1DataCw;
  }
  for (let i = 0; i < spec.group2Blocks; i += 1) {
    const block = dataCw.subarray(offset, offset + spec.group2DataCw);
    dataBlocks.push(block);
    ecBlocks.push(rsComputeRemainder(block, spec.ecPerBlock));
    offset += spec.group2DataCw;
  }

  const totalBlocks = dataBlocks.length;
  const maxDataLen = Math.max(spec.group1DataCw, spec.group2DataCw);
  const out = new Uint8Array(spec.totalDataCodewords + totalBlocks * spec.ecPerBlock);
  let pos = 0;

  for (let i = 0; i < maxDataLen; i += 1) {
    for (let b = 0; b < totalBlocks; b += 1) {
      const block = dataBlocks[b] as Uint8Array;
      if (i < block.length) {
        out[pos] = block[i] as number;
        pos += 1;
      }
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (let b = 0; b < totalBlocks; b += 1) {
      out[pos] = (ecBlocks[b] as Uint8Array)[i] as number;
      pos += 1;
    }
  }
  return out;
}

function computeFormatBits(mask: number): number {
  // EC Level M = 0b00, 3-bit mask.
  const data = mask & 0x7;
  let rem = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if ((rem >>> (i + 10)) & 1) {
      rem ^= 0x537 << i;
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version: number): number {
  let rem = version << 12;
  for (let i = 5; i >= 0; i -= 1) {
    if ((rem >>> (i + 12)) & 1) {
      rem ^= 0x1f25 << i;
    }
  }
  return (version << 12) | rem;
}

function maskMatches(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function drawFormatBits(grid: boolean[][], size: number, mask: number): void {
  const bits = computeFormatBits(mask);
  const bit = (idx: number): boolean => ((bits >>> idx) & 1) === 1;

  // Copy 1 around top-left finder.
  const topLeftCoords: ReadonlyArray<readonly [number, number]> = [
    [8, 0],
    [8, 1],
    [8, 2],
    [8, 3],
    [8, 4],
    [8, 5],
    [8, 7],
    [8, 8],
    [7, 8],
    [5, 8],
    [4, 8],
    [3, 8],
    [2, 8],
    [1, 8],
    [0, 8],
  ];
  for (let i = 0; i < 15; i += 1) {
    const [r, c] = topLeftCoords[i] as readonly [number, number];
    (grid[r] as boolean[])[c] = bit(14 - i);
  }

  // Copy 2 split across bottom-left and top-right finders.
  for (let i = 0; i < 7; i += 1) {
    (grid[size - 1 - i] as boolean[])[8] = bit(14 - i);
  }
  for (let i = 7; i < 15; i += 1) {
    (grid[8] as boolean[])[size - 15 + i] = bit(14 - i);
  }
}

function computePenalty(grid: boolean[][], size: number): number {
  let penalty = 0;

  // Rule 1: runs of 5+ same-colored modules in rows and columns.
  for (let r = 0; r < size; r += 1) {
    let rowRun = 1;
    let colRun = 1;
    for (let c = 1; c < size; c += 1) {
      if (grid[r]?.[c] === grid[r]?.[c - 1]) {
        rowRun += 1;
      } else {
        if (rowRun >= 5) penalty += 3 + (rowRun - 5);
        rowRun = 1;
      }
      if (grid[c]?.[r] === grid[c - 1]?.[r]) {
        colRun += 1;
      } else {
        if (colRun >= 5) penalty += 3 + (colRun - 5);
        colRun = 1;
      }
    }
    if (rowRun >= 5) penalty += 3 + (rowRun - 5);
    if (colRun >= 5) penalty += 3 + (colRun - 5);
  }

  // Rule 2: 2x2 blocks of identical color.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = grid[r]?.[c];
      if (v === grid[r]?.[c + 1] && v === grid[r + 1]?.[c] && v === grid[r + 1]?.[c + 1]) {
        penalty += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns flanked by 4 light modules.
  const isPattern = (line: boolean[], start: number): boolean => {
    const p1 =
      line[start] === true &&
      line[start + 1] === false &&
      line[start + 2] === true &&
      line[start + 3] === true &&
      line[start + 4] === true &&
      line[start + 5] === false &&
      line[start + 6] === true &&
      line[start + 7] === false &&
      line[start + 8] === false &&
      line[start + 9] === false &&
      line[start + 10] === false;
    const p2 =
      line[start] === false &&
      line[start + 1] === false &&
      line[start + 2] === false &&
      line[start + 3] === false &&
      line[start + 4] === true &&
      line[start + 5] === false &&
      line[start + 6] === true &&
      line[start + 7] === true &&
      line[start + 8] === true &&
      line[start + 9] === false &&
      line[start + 10] === true;
    return p1 || p2;
  };
  for (let i = 0; i < size; i += 1) {
    const row = grid[i] as boolean[];
    const col: boolean[] = new Array<boolean>(size);
    for (let r = 0; r < size; r += 1) col[r] = grid[r]?.[i] as boolean;
    for (let j = 0; j <= size - 11; j += 1) {
      if (isPattern(row, j)) penalty += 40;
      if (isPattern(col, j)) penalty += 40;
    }
  }

  // Rule 4: balance of dark vs. light modules.
  let darkCount = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (grid[r]?.[c]) darkCount += 1;
    }
  }
  const percent = (darkCount * 100) / (size * size);
  const k = Math.floor(Math.abs(percent - 50) / 5);
  penalty += k * 10;

  return penalty;
}

/**
 * Encodes `value` as an ISO/IEC 18004 Byte-mode QR Code matrix (Versions 1–10, Error Correction
 * Level M), evaluating all 8 mask patterns and selecting the lowest-penalty mask.
 * Returns `null` when the UTF-8 payload exceeds {@link MAX_QR_PAYLOAD_BYTES} (213 bytes).
 */
export function encodeQrMatrix(value: string): QrMatrix | null {
  const payload = encodeUtf8(value);
  const spec = VERSION_SPECS.find((s) => payload.length <= s.maxBytes);
  if (spec === undefined) return null;

  const size = 17 + 4 * spec.version;
  const base: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const isFn: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );

  const setFn = (r: number, c: number, dark: boolean): void => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    (base[r] as boolean[])[c] = dark;
    (isFn[r] as boolean[])[c] = true;
  };

  // Finder patterns + 1-module white separators.
  const drawFinder = (or: number, oc: number): void => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const border = r === 0 || r === 6 || c === 0 || c === 6;
        const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setFn(or + r, oc + c, inside && (border || center));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // Alignment patterns (skip only centers overlapping the 3 finder+separator corners,
  // never centers on the row/col 6 timing patterns in V7–V10).
  const centers = spec.alignmentCenters;
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = 0; j < centers.length; j += 1) {
      const cr = centers[i] as number;
      const cc = centers[j] as number;
      const overlapsFinder =
        (cr <= 8 && cc <= 8) || (cr <= 8 && cc >= size - 8) || (cr >= size - 8 && cc <= 8);
      if (overlapsFinder) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFn(cr + dr, cc + dc, dist !== 1);
        }
      }
    }
  }

  // Reserve format info strips + fixed dark module.
  for (let i = 0; i <= 8; i += 1) {
    if (!isFn[8]?.[i]) setFn(8, i, false);
    if (!isFn[i]?.[8]) setFn(i, 8, false);
  }
  for (let i = size - 8; i < size; i += 1) {
    if (!isFn[8]?.[i]) setFn(8, i, false);
    if (!isFn[i]?.[8]) setFn(i, 8, false);
  }
  setFn(4 * spec.version + 9, 8, true);

  // Version information blocks for V7-V10.
  if (spec.version >= 7) {
    const vBits = computeVersionBits(spec.version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((vBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }

  // Place interleaved data + EC bitstream in zig-zag order.
  const dataCw = buildDataCodewords(payload, spec);
  const stream = buildInterleavedStream(dataCw, spec);
  let bitIdx = 0;
  const totalBits = stream.length * 8;
  let upward = true;

  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5;
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx += 1) {
        const c = col - dx;
        if (isFn[r]?.[c]) continue;
        let dark = false;
        if (bitIdx < totalBits) {
          const byte = stream[bitIdx >>> 3] as number;
          dark = ((byte >>> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx += 1;
        }
        (base[r] as boolean[])[c] = dark;
      }
    }
    upward = !upward;
  }

  // Evaluate all 8 masks and select the lowest-penalty pattern.
  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  let bestGrid: boolean[][] = base;

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate: boolean[][] = base.map((row, r) =>
      row.map((val, c) => (isFn[r]?.[c] ? val : maskMatches(mask, r, c) ? !val : val)),
    );
    drawFormatBits(candidate, size, mask);
    const penalty = computePenalty(candidate, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestGrid = candidate;
    }
  }

  return {
    version: spec.version,
    size,
    mask: bestMask,
    modules: bestGrid,
  };
}
