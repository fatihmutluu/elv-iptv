const PACKET = 188;

/** PIDs of the first `count` transport packets; throws when the sync byte is missing. */
export function packetPids(data: Uint8Array, count: number): number[] {
  const pids: number[] = [];
  for (let i = 0; i < count && (i + 1) * PACKET <= data.length; i++) {
    const at = i * PACKET;
    if (data[at] !== 0x47) throw new Error(`no sync byte at packet ${i}`);
    pids.push((((data[at + 1] as number) & 0x1f) << 8) | (data[at + 2] as number));
  }
  return pids;
}

/**
 * True when the first packet that starts a PES (payload begins 00 00 01) carries the adaptation-field
 * random-access indicator, which the muxer sets on a keyframe.
 */
export function startsWithKeyframe(data: Uint8Array): boolean {
  for (let at = 0; at + PACKET <= data.length; at += PACKET) {
    const startsPayload = ((data[at + 1] as number) & 0x40) !== 0;
    const control = ((data[at + 3] as number) >> 4) & 3;
    if (!startsPayload || (control & 1) === 0) continue;
    const hasAdaptation = (control & 2) !== 0;
    const payload = hasAdaptation ? at + 5 + (data[at + 4] as number) : at + 4;
    if (data[payload] !== 0 || data[payload + 1] !== 0 || data[payload + 2] !== 1) continue;
    return hasAdaptation && (data[at + 4] as number) > 0 && ((data[at + 5] as number) & 0x40) !== 0;
  }
  return false;
}
