const PACKET = 188;

/**
 * PTS (33 bits, 90 kHz) of the first PES in `data` that has a video stream id (0xE0-0xEF) and a PTS,
 * walking whole 188-byte transport packets; null when there is none.
 */
export function firstVideoPts(data: Uint8Array): number | null {
  for (let at = 0; at + PACKET <= data.length; at += PACKET) {
    const byte = (offset: number): number => data[at + offset] as number;
    if (byte(0) !== 0x47 || (byte(1) & 0x40) === 0) continue;
    const control = (byte(3) >> 4) & 3;
    if ((control & 1) === 0) continue;
    const p = (control & 2) !== 0 ? 5 + byte(4) : 4;
    if (p + 14 > PACKET) continue;
    if (byte(p) !== 0 || byte(p + 1) !== 0 || byte(p + 2) !== 1) continue;
    const streamId = byte(p + 3);
    if (streamId < 0xe0 || streamId > 0xef || (byte(p + 7) & 0x80) === 0) continue;
    const high = (byte(p + 9) >> 1) & 0x07;
    const mid = (byte(p + 10) << 7) | (byte(p + 11) >> 1);
    const low = (byte(p + 12) << 7) | (byte(p + 13) >> 1);
    return high * 2 ** 30 + mid * 2 ** 15 + low;
  }
  return null;
}
