import { crc32, deflateSync } from 'node:zlib';

const SIZE = 256;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function hueToRgb(hue: number, lightness: number): [number, number, number] {
  const a = 0.5 * Math.min(lightness, 1 - lightness);
  const f = (n: number): number => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/** A deterministic 256x256 two-colour PNG for logo `n` (0-15), built with node:zlib. */
export function pngLogo(n: number): Buffer {
  const background = hueToRgb((n * 47) % 360, 0.3);
  const disc = hueToRgb((n * 47 + 180) % 360, 0.7);
  const radius = 64 + (n % 4) * 16;
  const center = SIZE / 2;
  const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const row = y * (SIZE * 3 + 1);
    for (let x = 0; x < SIZE; x++) {
      const inside = (x - center) ** 2 + (y - center) ** 2 <= radius ** 2;
      const [r, g, b] = inside ? disc : background;
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
