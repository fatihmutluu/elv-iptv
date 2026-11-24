import { encodeQrMatrix, MAX_QR_PAYLOAD_BYTES } from './qr-matrix';

describe('qr-matrix (ISO/IEC 18004 Byte-mode EC Level M)', () => {
  it('encodes short payloads into Version 1 (21x21) with valid finder, separator, timing, and dark modules', () => {
    const qr = encodeQrMatrix('HELLO');
    expect(qr).not.toBeNull();
    if (qr === null) return;

    expect(qr.version).toBe(1);
    expect(qr.size).toBe(21);
    expect(qr.mask).toBeGreaterThanOrEqual(0);
    expect(qr.mask).toBeLessThanOrEqual(7);
    expect(qr.modules).toHaveLength(21);
    for (const row of qr.modules) {
      expect(row).toHaveLength(21);
    }

    // Verify all 3 finder patterns (7x7 outer dark, 5x5 light ring, 3x3 dark center).
    const finderOrigins: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [0, qr.size - 7],
      [qr.size - 7, 0],
    ];
    for (const [or, oc] of finderOrigins) {
      for (let r = 0; r < 7; r += 1) {
        for (let c = 0; c < 7; c += 1) {
          const isBorder = r === 0 || r === 6 || c === 0 || c === 6;
          const isCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          expect(qr.modules[or + r]?.[oc + c]).toBe(isBorder || isCenter);
        }
      }
    }

    // Verify timing patterns on row 6 and col 6 between separators.
    for (let i = 8; i < qr.size - 8; i += 1) {
      expect(qr.modules[6]?.[i]).toBe(i % 2 === 0);
      expect(qr.modules[i]?.[6]).toBe(i % 2 === 0);
    }

    // Verify fixed dark module at (4 * version + 9, 8).
    expect(qr.modules[4 * qr.version + 9]?.[8]).toBe(true);
  });

  it('produces deterministic output for LAN pairing URLs across versions 1 through 10', () => {
    const lanUrl = 'http://192.168.1.42:54321/pair/0123456789abcdef0123456789abcdef';
    const first = encodeQrMatrix(lanUrl);
    const second = encodeQrMatrix(lanUrl);
    expect(first).not.toBeNull();
    expect(first).toEqual(second);
    if (first === null) return;

    // 63 bytes fits Version 5-M (max 84 bytes, size 37x37).
    expect(first.version).toBe(5);
    expect(first.size).toBe(37);

    // Alignment pattern center at (30, 30) for Version 5.
    expect(first.modules[30]?.[30]).toBe(true);
    expect(first.modules[29]?.[30]).toBe(false);
    expect(first.modules[28]?.[30]).toBe(true);
  });

  it('supports Version 7+ (version info blocks) and Version 10 (16-bit byte count) up to capacity', () => {
    const v7Payload = 'a'.repeat(115);
    const v7 = encodeQrMatrix(v7Payload);
    expect(v7).not.toBeNull();
    expect(v7?.version).toBe(7);
    expect(v7?.size).toBe(45);

    const v10Payload = 'x'.repeat(MAX_QR_PAYLOAD_BYTES);
    const v10 = encodeQrMatrix(v10Payload);
    expect(v10).not.toBeNull();
    expect(v10?.version).toBe(10);
    expect(v10?.size).toBe(57);

    // Exceeding V10-M capacity returns null cleanly.
    expect(encodeQrMatrix('x'.repeat(MAX_QR_PAYLOAD_BYTES + 1))).toBeNull();
  });

  it('handles multi-byte UTF-8 payloads accurately against byte capacity', () => {
    // 107 two-byte UTF-8 characters = 214 bytes > 213 byte cap.
    expect(encodeQrMatrix('ü'.repeat(107))).toBeNull();
    // 106 two-byte UTF-8 characters = 212 bytes <= 213 byte cap.
    const ok = encodeQrMatrix('ü'.repeat(106));
    expect(ok).not.toBeNull();
    expect(ok?.version).toBe(10);
  });

  it('produces valid, decodable ISO/IEC 18004 symbols with zero RS syndromes across V1 through V10', () => {
    // Independent ISO/IEC 18004 Table 9 + Table E.1 (EC Level M) specs for V1-V10.
    interface DecodeSpec {
      readonly version: number;
      readonly totalDataCw: number;
      readonly ecPerBlock: number;
      readonly g1Blocks: number;
      readonly g1DataCw: number;
      readonly g2Blocks: number;
      readonly g2DataCw: number;
      readonly alignment: readonly number[];
    }
    const SPECS: readonly DecodeSpec[] = [
      {
        version: 1,
        totalDataCw: 16,
        ecPerBlock: 10,
        g1Blocks: 1,
        g1DataCw: 16,
        g2Blocks: 0,
        g2DataCw: 0,
        alignment: [],
      },
      {
        version: 2,
        totalDataCw: 28,
        ecPerBlock: 16,
        g1Blocks: 1,
        g1DataCw: 28,
        g2Blocks: 0,
        g2DataCw: 0,
        alignment: [6, 18],
      },
      {
        version: 3,
        totalDataCw: 44,
        ecPerBlock: 26,
        g1Blocks: 1,
        g1DataCw: 44,
        g2Blocks: 0,
        g2DataCw: 0,
        alignment: [6, 22],
      },
      {
        version: 4,
        totalDataCw: 64,
        ecPerBlock: 18,
        g1Blocks: 2,
        g1DataCw: 32,
        g2Blocks: 0,
        g2DataCw: 0,
        alignment: [6, 26],
      },
      {
        version: 5,
        totalDataCw: 86,
        ecPerBlock: 24,
        g1Blocks: 2,
        g1DataCw: 43,
        g2Blocks: 0,
        g2DataCw: 0,
        alignment: [6, 30],
      },
      {
        version: 6,
        totalDataCw: 108,
        ecPerBlock: 16,
        g1Blocks: 4,
        g1DataCw: 27,
        g2Blocks: 0,
        g2DataCw: 0,
        alignment: [6, 34],
      },
      {
        version: 7,
        totalDataCw: 124,
        ecPerBlock: 18,
        g1Blocks: 4,
        g1DataCw: 31,
        g2Blocks: 0,
        g2DataCw: 0,
        alignment: [6, 22, 38],
      },
      {
        version: 8,
        totalDataCw: 154,
        ecPerBlock: 22,
        g1Blocks: 2,
        g1DataCw: 38,
        g2Blocks: 2,
        g2DataCw: 39,
        alignment: [6, 24, 42],
      },
      {
        version: 9,
        totalDataCw: 182,
        ecPerBlock: 22,
        g1Blocks: 3,
        g1DataCw: 36,
        g2Blocks: 2,
        g2DataCw: 37,
        alignment: [6, 26, 46],
      },
      {
        version: 10,
        totalDataCw: 216,
        ecPerBlock: 26,
        g1Blocks: 4,
        g1DataCw: 43,
        g2Blocks: 1,
        g2DataCw: 44,
        alignment: [6, 28, 50],
      },
    ];

    // Independent GF(256) arithmetic (primitive poly 0x11d) for RS syndrome evaluation.
    const gfExp = new Uint8Array(512);
    const gfLog = new Uint8Array(256);
    for (let x = 1, i = 0; i < 255; i += 1) {
      gfExp[i] = x;
      gfLog[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) gfExp[i] = gfExp[i - 255] as number;
    const gfMul = (a: number, b: number): number =>
      a === 0 || b === 0 ? 0 : (gfExp[(gfLog[a] as number) + (gfLog[b] as number)] as number);

    const evalMask = (mask: number, r: number, c: number): boolean => {
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
    };

    const decodeAndVerify = (payload: string, expectedVersion: number): void => {
      const qr = encodeQrMatrix(payload);
      expect(qr).not.toBeNull();
      if (qr === null) return;
      expect(qr.version).toBe(expectedVersion);

      const spec = SPECS[expectedVersion - 1] as DecodeSpec;
      const size = 17 + 4 * spec.version;
      expect(qr.size).toBe(size);

      // 1. Read and verify both format information strips (BCH(15,5) + mask 0x5412).
      const copy1Coords: ReadonlyArray<readonly [number, number]> = [
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
      let fmt1 = 0;
      for (const [r, c] of copy1Coords) {
        fmt1 = (fmt1 << 1) | (qr.modules[r]?.[c] ? 1 : 0);
      }
      let fmt2 = 0;
      for (let i = 0; i < 7; i += 1) {
        fmt2 = (fmt2 << 1) | (qr.modules[size - 1 - i]?.[8] ? 1 : 0);
      }
      for (let i = 7; i < 15; i += 1) {
        fmt2 = (fmt2 << 1) | (qr.modules[8]?.[size - 15 + i] ? 1 : 0);
      }
      expect(fmt1).toBe(fmt2);
      const rawFmt = fmt1 ^ 0x5412;
      let fmtRem = rawFmt;
      for (let i = 4; i >= 0; i -= 1) {
        if ((fmtRem >>> (i + 10)) & 1) fmtRem ^= 0x537 << i;
      }
      expect(fmtRem).toBe(0);
      const ecBits = (rawFmt >>> 13) & 0x3;
      const mask = (rawFmt >>> 10) & 0x7;
      expect(ecBits).toBe(0b00); // EC Level M
      expect(mask).toBe(qr.mask);

      // 2. For V7-V10, verify both 18-bit version info blocks (BCH(18,6)).
      if (spec.version >= 7) {
        let v1 = 0;
        let v2 = 0;
        for (let i = 0; i < 18; i += 1) {
          const a = Math.floor(i / 3);
          const b = size - 11 + (i % 3);
          if (qr.modules[a]?.[b]) v1 |= 1 << i;
          if (qr.modules[b]?.[a]) v2 |= 1 << i;
        }
        expect(v1).toBe(v2);
        let vRem = v1;
        for (let i = 5; i >= 0; i -= 1) {
          if ((vRem >>> (i + 12)) & 1) vRem ^= 0x1f25 << i;
        }
        expect(vRem).toBe(0);
        expect(v1 >>> 12).toBe(spec.version);
      }

      // 3. Build independent function-module mask & verify all alignment patterns (including (6, mid) / (mid, 6)).
      const isFn: boolean[][] = Array.from({ length: size }, () =>
        new Array<boolean>(size).fill(false),
      );
      const markFn = (r: number, c: number): void => {
        if (r >= 0 && c >= 0 && r < size && c < size) (isFn[r] as boolean[])[c] = true;
      };
      // Finders + separators + format strips.
      for (let r = 0; r <= 8; r += 1) {
        for (let c = 0; c <= 8; c += 1) markFn(r, c);
      }
      for (let r = 0; r <= 8; r += 1) {
        for (let c = size - 8; c < size; c += 1) markFn(r, c);
      }
      for (let r = size - 8; r < size; r += 1) {
        for (let c = 0; c <= 8; c += 1) markFn(r, c);
      }
      // Timing patterns.
      for (let i = 8; i < size - 8; i += 1) {
        markFn(6, i);
        markFn(i, 6);
      }
      // Alignment patterns (skip only the 3 finder corners).
      for (const cr of spec.alignment) {
        for (const cc of spec.alignment) {
          const inFinder =
            (cr <= 8 && cc <= 8) || (cr <= 8 && cc >= size - 8) || (cr >= size - 8 && cc <= 8);
          if (inFinder) continue;
          for (let dr = -2; dr <= 2; dr += 1) {
            for (let dc = -2; dc <= 2; dc += 1) {
              const dist = Math.max(Math.abs(dr), Math.abs(dc));
              expect(qr.modules[cr + dr]?.[cc + dc]).toBe(dist !== 1);
              markFn(cr + dr, cc + dc);
            }
          }
        }
      }
      // Version info blocks for V7-V10.
      if (spec.version >= 7) {
        for (let i = 0; i < 6; i += 1) {
          for (let j = 0; j < 3; j += 1) {
            markFn(i, size - 11 + j);
            markFn(size - 11 + j, i);
          }
        }
      }

      // 4. Read unmasked zig-zag bitstream into codewords.
      const totalBlocks = spec.g1Blocks + spec.g2Blocks;
      const totalCodewords = spec.totalDataCw + totalBlocks * spec.ecPerBlock;
      const bits: number[] = [];
      let upward = true;
      for (let col = size - 1; col >= 1; col -= 2) {
        if (col === 6) col = 5;
        for (let step = 0; step < size; step += 1) {
          const r = upward ? size - 1 - step : step;
          for (let dx = 0; dx < 2; dx += 1) {
            const c = col - dx;
            if (isFn[r]?.[c]) continue;
            const raw = Boolean(qr.modules[r]?.[c]);
            const unmasked = evalMask(mask, r, c) ? !raw : raw;
            bits.push(unmasked ? 1 : 0);
          }
        }
        upward = !upward;
      }

      const stream = new Uint8Array(totalCodewords);
      for (let i = 0; i < totalCodewords; i += 1) {
        let byte = 0;
        for (let b = 0; b < 8; b += 1) {
          byte = (byte << 1) | (bits[i * 8 + b] as number);
        }
        stream[i] = byte;
      }

      // 5. De-interleave data + EC blocks and check every Reed-Solomon syndrome == 0.
      const dataBlocks: Uint8Array[] = [];
      for (let i = 0; i < spec.g1Blocks; i += 1) dataBlocks.push(new Uint8Array(spec.g1DataCw));
      for (let i = 0; i < spec.g2Blocks; i += 1) dataBlocks.push(new Uint8Array(spec.g2DataCw));
      const ecBlocks: Uint8Array[] = Array.from(
        { length: totalBlocks },
        () => new Uint8Array(spec.ecPerBlock),
      );

      let pos = 0;
      const maxDataLen = Math.max(spec.g1DataCw, spec.g2DataCw);
      for (let i = 0; i < maxDataLen; i += 1) {
        for (let b = 0; b < totalBlocks; b += 1) {
          const blk = dataBlocks[b] as Uint8Array;
          if (i < blk.length) {
            blk[i] = stream[pos] as number;
            pos += 1;
          }
        }
      }
      for (let i = 0; i < spec.ecPerBlock; i += 1) {
        for (let b = 0; b < totalBlocks; b += 1) {
          (ecBlocks[b] as Uint8Array)[i] = stream[pos] as number;
          pos += 1;
        }
      }

      for (let b = 0; b < totalBlocks; b += 1) {
        const dBlk = dataBlocks[b] as Uint8Array;
        const eBlk = ecBlocks[b] as Uint8Array;
        const full = new Uint8Array(dBlk.length + eBlk.length);
        full.set(dBlk, 0);
        full.set(eBlk, dBlk.length);
        // Evaluate codeword polynomial at alpha^0 .. alpha^(ecPerBlock - 1) via Horner's method.
        for (let s = 0; s < spec.ecPerBlock; s += 1) {
          const root = gfExp[s] as number;
          let syndrome = 0;
          for (let k = 0; k < full.length; k += 1) {
            syndrome = gfMul(syndrome, root) ^ (full[k] as number);
          }
          expect(syndrome).toBe(0);
        }
      }

      // 6. Concatenate data blocks and decode Byte-mode UTF-8 payload.
      const dataBytes = new Uint8Array(spec.totalDataCw);
      let dOff = 0;
      for (const blk of dataBlocks) {
        dataBytes.set(blk, dOff);
        dOff += blk.length;
      }
      const dataBits: number[] = [];
      for (const byte of dataBytes) {
        for (let i = 7; i >= 0; i -= 1) dataBits.push((byte >>> i) & 1);
      }
      const readBits = (start: number, len: number): number => {
        let val = 0;
        for (let i = 0; i < len; i += 1) val = (val << 1) | (dataBits[start + i] as number);
        return val;
      };
      expect(readBits(0, 4)).toBe(0b0100); // Byte mode
      const countLen = spec.version <= 9 ? 8 : 16;
      const byteLen = readBits(4, countLen);
      const outBytes = new Uint8Array(byteLen);
      const payloadStart = 4 + countLen;
      for (let i = 0; i < byteLen; i += 1) {
        outBytes[i] = readBits(payloadStart + i * 8, 8);
      }
      // Pure UTF-8 decode so the test stays independent of DOM/Node ambient types.
      let decoded = '';
      for (let i = 0; i < outBytes.length; ) {
        const b0 = outBytes[i] as number;
        if (b0 < 0x80) {
          decoded += String.fromCharCode(b0);
          i += 1;
        } else if ((b0 & 0xe0) === 0xc0) {
          const b1 = outBytes[i + 1] as number;
          decoded += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
          i += 2;
        } else if ((b0 & 0xf0) === 0xe0) {
          const b1 = outBytes[i + 1] as number;
          const b2 = outBytes[i + 2] as number;
          decoded += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
          i += 3;
        } else {
          const b1 = outBytes[i + 1] as number;
          const b2 = outBytes[i + 2] as number;
          const b3 = outBytes[i + 3] as number;
          const cp =
            (((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f)) -
            0x10000;
          decoded += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
          i += 4;
        }
      }
      expect(decoded).toBe(payload);
    };

    const cases: ReadonlyArray<readonly [string, number]> = [
      ['HELLO-V1', 1],
      ['http://10.0.0.1:8080/p', 2],
      ['http://192.168.1.5:12345/pair/0123456789', 3],
      ['http://192.168.1.42:54321/pair/0123456789abcdef012345', 4],
      ['http://192.168.1.42:54321/pair/0123456789abcdef0123456789abcdef0123456789abcdef', 5],
      [`https://lan-pair.local:54321/pair/${'a'.repeat(68)}`, 6],
      // V7 (107..122 bytes): exercises (6, 22) and (22, 6) alignment centers on timing lines.
      [
        'http://192.168.100.200:54321/pair/0123456789abcdef0123456789abcdef?lang=tr&host=living-room-tv&session=v7-check12',
        7,
      ],
      // V8 (123..152 bytes): exercises (6, 24) and (24, 6) + mixed RS block groups.
      [`http://192.168.100.200:54321/pair/${'0123456789abcdef'.repeat(6)}?device=android-tv`, 8],
      // V9 (153..180 bytes): exercises (6, 26) and (26, 6).
      [`http://192.168.100.200:54321/pair/${'0123456789abcdef'.repeat(8)}?device=apple-tv`, 9],
      // V10 (181..213 bytes): exercises (6, 28) and (28, 6) + 16-bit byte count indicator.
      [`http://192.168.100.200:54321/pair/${'0123456789abcdef'.repeat(10)}?device=desktop-v10`, 10],
    ];

    for (const [payload, version] of cases) {
      decodeAndVerify(payload, version);
    }
  });
});
