import { describe, expect, it } from 'vitest';
import { type M3uBatch, type M3uEntry, scanM3u } from './m3u';
import { chunksOf, utf8 } from './test-chunks';

async function run(text: string, opts?: { baseUrl?: string }) {
  const bytes = utf8(text);
  const gen = scanM3u(chunksOf(bytes, [bytes.length]), opts);
  const batches: M3uBatch[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { batches, result: r.value };
    batches.push(r.value);
  }
}

const one = async (text: string, opts?: { baseUrl?: string }): Promise<M3uEntry> => {
  const { batches, result } = await run(text, opts);
  expect(result.ok).toBe(true);
  const all = batches.flatMap((b) => b.entries);
  expect(all).toHaveLength(1);
  return all[0] as M3uEntry;
};

describe('M3U pre-#EXTINF directives, EXTVLCOPT headers, and VOD/episodic kindOf parity (M3U-1, M3U-4)', () => {
  it('buffers pre-#EXTINF #KODIPROP, #EXTVLCOPT, #EXTHTTP, and #EXTGRP and lets post-#EXTINF directives override (M3U-1)', async () => {
    const hexKid = '00112233445566778899aabbccddeeff';
    const hexKey = 'ffeeddccbbaa99887766554433221100';
    const text = [
      '#EXTM3U',
      '#KODIPROP:inputstream.adaptive.license_type=org.w3.clearkey',
      `#KODIPROP:inputstream.adaptive.license_key=${hexKid}:${hexKey}`,
      '#EXTVLCOPT:http-user-agent=PreUA/1',
      '#EXTVLCOPT:http-origin=https://origin.example',
      '#EXTGRP:PreGroup',
      '#EXTINF:-1,Pre-Directive Channel',
      '#EXTVLCOPT:http-user-agent=PostUA/2',
      'https://cdn.example/live/ck.mpd',
      '#EXTVLCOPT:http-referrer=https://bare.example/',
      'https://cdn.example/live/bare.ts',
      '#EXTM3U',
      '#EXTVLCOPT:http-user-agent=StaleBeforeHeader',
      '#EXTM3U',
      '#EXTINF:-1,Clean Next',
      'https://cdn.example/live/clean.ts',
      '#KODIPROP:inputstream.adaptive.license_type=clearkey',
      '',
    ].join('\n');

    const { batches, result } = await run(text);
    expect(result.ok).toBe(true);
    const entries = batches.flatMap((b) => b.entries);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      name: 'Pre-Directive Channel',
      groups: ['PreGroup'],
      headers: {
        userAgent: 'PostUA/2',
        other: { origin: 'https://origin.example' },
      },
      drm: {
        scheme: 'clearkey',
        clearKeys: [{ kid: hexKid, key: hexKey }],
      },
    });
    expect(entries[1]).toMatchObject({
      url: 'https://cdn.example/live/bare.ts',
      headers: { referer: 'https://bare.example/', other: {} },
    });
    expect(entries[2]).toMatchObject({
      name: 'Clean Next',
      headers: { other: {} },
    });
    expect(entries[2]?.drm).toBeUndefined();
    expect(batches.at(-1)?.stats?.warnings).toEqual([]);
  });

  it('clears queued pre-directives on non-URL lines and line-too-long resets without leaking (M3U-1)', async () => {
    const text = [
      '#EXTM3U',
      '#EXTVLCOPT:http-user-agent=LeakedUA',
      'not a valid url line',
      '#EXTINF:-1,Safe Channel',
      'https://cdn.example/live/safe.ts',
      '',
    ].join('\n');
    const { batches } = await run(text);
    const entries = batches.flatMap((b) => b.entries);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.headers.userAgent).toBeUndefined();
  });

  it('maps #EXTVLCOPT http-origin, http-cookie, and http-x-forwarded-for while rejecting hop-by-hop headers', async () => {
    const e = await one(
      [
        '#EXTINF:-1,Headers Test',
        '#EXTVLCOPT:http-origin=https://player.example',
        '#EXTVLCOPT:http-cookie=session=abc123',
        '#EXTVLCOPT:http-x-forwarded-for=203.0.113.9',
        '#EXTHTTP:{"Host":"evil.example","Connection":"keep-alive","Content-Length":"99","Transfer-Encoding":"chunked","TE":"trailers","Upgrade":"websocket","X-Safe":"ok"}',
        'https://cdn.example/live/1.m3u8',
        '',
      ].join('\n'),
    );
    expect(e.headers.other).toEqual({
      origin: 'https://player.example',
      cookie: 'session=abc123',
      'x-forwarded-for': '203.0.113.9',
      'x-safe': 'ok',
    });
  });

  it('detects extended VOD containers, query-declared format/ext/extension hints, and Unicode episode markers (M3U-4)', async () => {
    for (const ext of ['m4v', 'm2ts', 'rm', 'rmvb', 'vob', 'divx', 'asf']) {
      expect(
        (await one(`#EXTINF:-1,Film\nhttps://cdn.example/media/clip.${ext}\n`)).kindHint,
        ext,
      ).toBe('movie');
    }
    expect((await one('#EXTINF:-1,Film\nhttps://cdn.example/stream.php?ext=mkv\n')).kindHint).toBe(
      'movie',
    );
    expect(
      (await one('#EXTINF:-1,Film\nhttps://cdn.example/play.asp?extension=mp4\n')).kindHint,
    ).toBe('movie');
    expect(
      (await one('#EXTINF:-1,Live\nhttps://cdn.example/stream.php?format=hls\n')).kindHint,
    ).toBe('live');
    expect(
      (await one('#EXTINF:-1,ScriptOnly\nhttps://cdn.example/stream.php?id=10\n')).kindHint,
    ).toBe('live');

    for (const title of [
      'Drama Серия 5',
      'Show Эпизод 12',
      'Dizi Bölüm 3',
      'Serie Episodio 8',
      'Krimi Folge 4',
      'Serial Odcinek 2',
      'Reeks Aflevering 6',
      'Show Episode 9',
    ]) {
      expect(
        (await one(`#EXTINF:-1,${title}\nhttps://cdn.example/media/video.mkv\n`)).kindHint,
        title,
      ).toBe('episode');
    }
  });
});
