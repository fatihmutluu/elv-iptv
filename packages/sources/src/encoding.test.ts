import { ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createXtreamClient, detectAndDecodeText, scanM3u } from './index';
import { chunksOf } from './test-chunks';
import { PASS, USER } from './xtream-test-helpers';

function encodeUtf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = littleEndian ? 0xff : 0xfe;
  out[1] = littleEndian ? 0xfe : 0xff;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const offset = 2 + i * 2;
    if (littleEndian) {
      out[offset] = code & 0xff;
      out[offset + 1] = (code >> 8) & 0xff;
    } else {
      out[offset] = (code >> 8) & 0xff;
      out[offset + 1] = code & 0xff;
    }
  }
  return out;
}

function encodeUtf32(text: string, littleEndian: boolean): Uint8Array {
  const cps = [...text].map((ch) => ch.codePointAt(0) ?? 0);
  const out = new Uint8Array(4 + cps.length * 4);
  if (littleEndian) {
    out.set([0xff, 0xfe, 0x00, 0x00], 0);
  } else {
    out.set([0x00, 0x00, 0xfe, 0xff], 0);
  }
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i] ?? 0;
    const o = 4 + i * 4;
    if (littleEndian) {
      out[o] = cp & 0xff;
      out[o + 1] = (cp >> 8) & 0xff;
      out[o + 2] = (cp >> 16) & 0xff;
      out[o + 3] = (cp >> 24) & 0xff;
    } else {
      out[o] = (cp >> 24) & 0xff;
      out[o + 1] = (cp >> 16) & 0xff;
      out[o + 2] = (cp >> 8) & 0xff;
      out[o + 3] = cp & 0xff;
    }
  }
  return out;
}

describe('detectAndDecodeText (#282, #120)', () => {
  it('strips UTF-8 BOM and decodes UTF-16LE/BE and UTF-32LE/BE BOMs', () => {
    const sample = 'Şampiyon ğüşıöçİ';
    const utf8WithBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(sample)]);
    expect(detectAndDecodeText(utf8WithBom)).toBe(sample);
    expect(detectAndDecodeText(encodeUtf16(sample, true))).toBe(sample);
    expect(detectAndDecodeText(encodeUtf16(sample, false))).toBe(sample);
    expect(detectAndDecodeText(encodeUtf32('Tr 🎬', true))).toBe('Tr 🎬');
    expect(detectAndDecodeText(encodeUtf32('Tr 🎬', false))).toBe('Tr 🎬');
  });

  it('decodes single-byte Turkish Windows-1254 and Western CP1252 when invalid UTF-8', () => {
    // "Türkiye Eğlence Şov İğdır" in Windows-1254:
    // ü=0xFC, ğ=0xF0, Ş=0xDE, İ=0xDD, ı=0xFD
    const win1254 = Uint8Array.from([
      0x54, 0xfc, 0x72, 0x6b, 0x69, 0x79, 0x65, 0x20, 0x45, 0xf0, 0x6c, 0x65, 0x6e, 0x63, 0x65,
      0x20, 0xde, 0x6f, 0x76, 0x20, 0xdd, 0xf0, 0x64, 0xfd, 0x72,
    ]);
    expect(detectAndDecodeText(win1254)).toBe('Türkiye Eğlence Şov İğdır');

    // CP1252 "Café €10 — Español": é=0xE9, €=0x80, —=0x97, ñ=0xF1
    const cp1252 = Uint8Array.from([
      0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x31, 0x30, 0x20, 0x97, 0x20, 0x45, 0x73, 0x70, 0x61,
      0xf1, 0x6f, 0x6c,
    ]);
    expect(detectAndDecodeText(cp1252)).toBe('Café €10 — Español');
  });

  it('decodes Windows-1254 and UTF-16LE M3U playlists and Xtream JSON responses', async () => {
    // "#EXTM3U\n#EXTINF:-1,Belgesel Kuşağı\nhttp://h.example/1.ts\n" in Windows-1254 (ş=0xFE, ğ=0xF0, ı=0xFD)
    const m3uWin1254 = Uint8Array.from([
      ...new TextEncoder().encode('#EXTM3U\n#EXTINF:-1,Belgesel Ku'),
      0xfe,
      0x61,
      0xf0,
      0xfd,
      ...new TextEncoder().encode('\nhttp://h.example/1.ts\n'),
    ]);
    const names1254: string[] = [];
    for await (const b of scanM3u(chunksOf(m3uWin1254, [15, m3uWin1254.length]))) {
      names1254.push(...b.entries.map((e) => e.name));
    }
    expect(names1254).toEqual(['Belgesel Kuşağı']);

    const utf16Playlist = encodeUtf16(
      '#EXTM3U\r\n#EXTINF:-1,İzmir TV\r\nhttp://h.example/2.ts\r\n',
      true,
    );
    const names16: string[] = [];
    for await (const b of scanM3u(chunksOf(utf16Playlist, [7, 13, utf16Playlist.length]))) {
      names16.push(...b.entries.map((e) => e.name));
    }
    expect(names16).toEqual(['İzmir TV']);

    // Xtream JSON with UTF-8 BOM + Windows-1254 fallback
    const xtreamWin1254 = Uint8Array.from([
      ...new TextEncoder().encode('[{"stream_id":1,"name":"'),
      0xdd,
      0x73,
      0x74,
      0x61,
      0x6e,
      0x62,
      0x75,
      0x6c,
      ...new TextEncoder().encode('"}]'),
    ]);
    const c = createXtreamClient({
      http: {
        async get() {
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              yield xtreamWin1254;
            })(),
          });
        },
      },
      server: 'http://h.example',
      username: USER,
      password: PASS,
    });
    const res = await c.liveStreams();
    expect(res).toEqual({
      ok: true,
      value: [{ id: 1, name: 'İstanbul', categoryIds: [], catchupDays: 0 }],
    });
  });
});
