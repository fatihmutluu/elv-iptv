/** A local playlist file picked through Android Storage Access Framework (`#51`). */
export interface AndroidPickedPlaylistFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** Raw native payload returned by `ElvEngineMedia3.pickPlaylistFile()`. */
export interface RawPickedPlaylistFile {
  name?: unknown;
  bytes?: unknown;
  base64?: unknown;
}

const B64_TABLE = new Int16Array(128).fill(-1);
for (let i = 0; i < 26; i += 1) {
  B64_TABLE[65 + i] = i;
  B64_TABLE[97 + i] = i + 26;
}
for (let i = 0; i < 10; i += 1) B64_TABLE[48 + i] = i + 52;
B64_TABLE[43] = 62;
B64_TABLE[47] = 63;

function decodeBase64(input: string): Uint8Array | null {
  let cleanLen = 0;
  let padding = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 10 || code === 13 || code === 32 || code === 9) continue;
    if (code === 61) {
      padding += 1;
      cleanLen += 1;
      continue;
    }
    if (padding > 0 || code >= 128 || B64_TABLE[code] === -1) return null;
    cleanLen += 1;
  }
  if (cleanLen === 0) return new Uint8Array(0);
  if (cleanLen % 4 !== 0 || padding > 2) return null;
  const out = new Uint8Array((cleanLen / 4) * 3 - padding);
  let outIdx = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 10 || code === 13 || code === 32 || code === 9 || code === 61) continue;
    const val = B64_TABLE[code] ?? -1;
    acc = (acc << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (outIdx < out.length) out[outIdx++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** Normalizes a raw Android SAF playlist picker payload into an {@link AndroidPickedPlaylistFile}. */
export function normalizePickedPlaylist(raw: unknown): AndroidPickedPlaylistFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as RawPickedPlaylistFile;
  const name =
    typeof r.name === 'string' && r.name.trim().length > 0 ? r.name.trim() : 'playlist.m3u';
  if (r.bytes instanceof Uint8Array) return { name, bytes: r.bytes };
  if (typeof r.base64 === 'string') {
    const decoded = decodeBase64(r.base64);
    if (decoded !== null) return { name, bytes: decoded };
  }
  return null;
}
