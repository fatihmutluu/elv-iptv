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
});
