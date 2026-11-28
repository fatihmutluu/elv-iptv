import { elvError, type HttpClient, ok, type Result } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createXtreamClient, streamXtreamRecords } from './index';
import type { Raw } from './xtream-records';
import { expectErr, PASS, USER } from './xtream-test-helpers';

const enc = (s: string) => new TextEncoder().encode(s);

async function* chunksOf(bytes: Uint8Array, sizes: readonly number[]): AsyncGenerator<Uint8Array> {
  let offset = 0;
  let i = 0;
  while (offset < bytes.length) {
    const size = sizes[i % sizes.length] ?? 1;
    i++;
    yield bytes.subarray(offset, Math.min(bytes.length, offset + size));
    offset += size;
  }
}

async function collectGen<T>(
  gen: AsyncGenerator<T[], Result<void>>,
): Promise<{ batches: T[][]; result: Result<void> }> {
  const batches: T[][] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { batches, result: step.value };
    batches.push(step.value);
  }
}

function encodeUtf16(text: string, le: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = le ? 0xff : 0xfe;
  out[1] = le ? 0xfe : 0xff;
  for (let i = 0; i < text.length; i++) {
    const u = text.charCodeAt(i);
    if (le) {
      out[2 + i * 2] = u & 0xff;
      out[2 + i * 2 + 1] = u >> 8;
    } else {
      out[2 + i * 2] = u >> 8;
      out[2 + i * 2 + 1] = u & 0xff;
    }
  }
  return out;
}

function encodeUtf32(text: string, le: boolean): Uint8Array {
  const cps = [...text].map((ch) => ch.codePointAt(0) as number);
  const out = new Uint8Array(4 + cps.length * 4);
  if (le) {
    out.set([0xff, 0xfe, 0x00, 0x00], 0);
  } else {
    out.set([0x00, 0x00, 0xfe, 0xff], 0);
  }
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i] as number;
    const o = 4 + i * 4;
    if (le) {
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

describe('streamXtreamRecords', () => {
  it('streams top-level JSON arrays in bounded batches before EOF', async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      stream_id: i + 1,
      name: `Channel ${i + 1}`,
      nested: { tags: ['hd', i], flag: i % 2 === 0 },
    }));
    const bytes = enc(JSON.stringify(items));
    const gen = streamXtreamRecords(chunksOf(bytes, [17, 23, 11]), { batchSize: 3 });

    // Verify incremental yield: first batch arrives before whole stream is consumed
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual(items.slice(0, 3));

    const rest = await collectGen(gen);
    expect(rest.result).toEqual(ok(undefined));
    expect(rest.batches).toEqual([items.slice(3, 6), items.slice(6)]);
  });

  it('matches JSON.parse identically under 1-byte and pseudo-random chunk splits with Unicode and escapes', async () => {
    const items: Raw[] = [
      { stream_id: 1, name: 'İstanbul Ğüzel Şehir 🎬', quote: 'He said "hi\\there"', arr: [1, 2] },
      { stream_id: 2, name: 'Emoji 🚀 & CJK 東京', nested: { a: { b: 'c' } }, empty: '' },
      { stream_id: 3, name: 'Special } ] , : " \\ chars inside string', num: -42.5, flag: true },
      { stream_id: 4, name: 'Nullish', extra: null },
    ];
    const jsonText = `  \n\t ${JSON.stringify(items)} \r\n `;
    const bytes = enc(jsonText);

    // 1-byte split
    const oneByte = await collectGen(streamXtreamRecords(chunksOf(bytes, [1]), { batchSize: 2 }));
    expect(oneByte.result).toEqual(ok(undefined));
    expect(oneByte.batches.flat()).toEqual(items);

    // Deterministic PRNG random splits across 10 seeds
    for (let seed = 1; seed <= 10; seed++) {
      let state = seed * 2654435761;
      const sizes: number[] = [];
      for (let k = 0; k < 64; k++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        sizes.push((state % 13) + 1);
      }
      const res = await collectGen(streamXtreamRecords(chunksOf(bytes, sizes), { batchSize: 3 }));
      expect(res.result).toEqual(ok(undefined));
      expect(res.batches.flat()).toEqual(items);
    }
  });

  it('handles UTF-8, UTF-16LE/BE, and UTF-32LE/BE BOMs even on 1-byte splits', async () => {
    const items = [{ stream_id: 1, name: 'Şeker 🎬' }];
    const text = JSON.stringify(items);

    const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(text)]);
    for (const sample of [
      utf8Bom,
      encodeUtf16(text, true),
      encodeUtf16(text, false),
      encodeUtf32(text, true),
      encodeUtf32(text, false),
    ]) {
      const res = await collectGen(streamXtreamRecords(chunksOf(sample, [1]), { batchSize: 10 }));
      expect(res.result).toEqual(ok(undefined));
      expect(res.batches.flat()).toEqual(items);
    }
  });

  it('streams PHP numeric-keyed object maps and rejects non-Raw or non-numeric object shapes', async () => {
    const phpObj = {
      '0': { stream_id: 10, name: 'Alpha' },
      '2': { stream_id: 20, name: 'Beta' },
      '10': { stream_id: 30, name: 'Gamma' },
    };
    const okRes = await collectGen(
      streamXtreamRecords(chunksOf(enc(JSON.stringify(phpObj)), [1]), { batchSize: 2 }),
    );
    expect(okRes.result).toEqual(ok(undefined));
    expect(okRes.batches).toEqual([[phpObj['0'], phpObj['2']], [phpObj['10']]]);

    const nonRawEntry = await collectGen(
      streamXtreamRecords(chunksOf(enc('{"0":{"stream_id":1},"1":"oops"}'), [7]), {
        batchSize: 10,
      }),
    );
    expectErr(nonRawEntry.result, 'source-format', 'unexpected-shape');
    expect(nonRawEntry.batches).toEqual([]);

    const nonNumericKey = await collectGen(
      streamXtreamRecords(chunksOf(enc('{"status":"error","items":[]}'), [5]), { batchSize: 10 }),
    );
    expectErr(nonNumericKey.result, 'source-format', 'unexpected-shape');
    expect(nonNumericKey.batches).toEqual([]);
  });

  it('filters non-Raw entries inside top-level arrays matching xtream rows() semantics', async () => {
    const raw = '[null, 123, "hello", true, false, [1, 2], {"stream_id":1,"name":"Keep"}]';
    const res = await collectGen(streamXtreamRecords(chunksOf(enc(raw), [1]), { batchSize: 10 }));
    expect(res.result).toEqual(ok(undefined));
    expect(res.batches).toEqual([[{ stream_id: 1, name: 'Keep' }]]);
  });

  it('treats null, false, [], and {} as empty success; rejects true, numbers, strings, and empty input', async () => {
    for (const empty of ['null', 'false', '[]', '{}', '  {}  ', ' [  ] ']) {
      const res = await collectGen(streamXtreamRecords(chunksOf(enc(empty), [1])));
      expect(res.result).toEqual(ok(undefined));
      expect(res.batches).toEqual([]);
    }
    for (const badShape of ['true', '42', '"hello"']) {
      const res = await collectGen(streamXtreamRecords(chunksOf(enc(badShape), [2])));
      expectErr(res.result, 'source-format', 'unexpected-shape');
      expect(res.batches).toEqual([]);
    }
    for (const invalid of ['', '   \n\t  ', 'not-json', '[] trailing', '{} extra']) {
      const res = await collectGen(streamXtreamRecords(chunksOf(enc(invalid), [2])));
      expectErr(res.result, 'source-format', 'invalid-json');
    }
  });

  it('extracts user_info auth failures regardless of key order', async () => {
    const auth0 = await collectGen(
      streamXtreamRecords(chunksOf(enc('{"user_info":{"auth":0}}'), [4])),
    );
    expectErr(auth0.result, 'auth', 'invalid-credentials');

    const expiredAfterServer = await collectGen(
      streamXtreamRecords(
        chunksOf(
          enc('{"server_info":{"url":"x","port":80},"user_info":{"auth":1,"status":"Expired"}}'),
          [3],
        ),
      ),
    );
    expectErr(expiredAfterServer.result, 'auth', 'account-expired');

    const activeEnvelope = await collectGen(
      streamXtreamRecords(chunksOf(enc('{"user_info":{"auth":1,"status":"Active"}}'), [5])),
    );
    expectErr(activeEnvelope.result, 'source-format', 'unexpected-shape');

    const disabledWithExtraMeta = await collectGen(
      streamXtreamRecords(
        chunksOf(
          enc(
            '{"server_info":{"url":"x"},"categories":[],"user_info":{"auth":"false","status":"Active"}}',
          ),
          [4],
        ),
      ),
    );
    expectErr(disabledWithExtraMeta.result, 'auth', 'invalid-credentials');

    const bannedAfterServer = await collectGen(
      streamXtreamRecords(
        chunksOf(enc('{"server_info":{"url":"x"},"user_info":{"auth":1,"status":"banned"}}'), [4]),
      ),
    );
    expectErr(bannedAfterServer.result, 'auth', 'account-disabled');

    const expiredByDate = await collectGen(
      streamXtreamRecords(
        chunksOf(
          enc(
            '{"server_info":{"url":"x"},"user_info":{"auth":1,"status":"Active","exp_date":"1600000000"}}',
          ),
          [4],
        ),
      ),
    );
    expectErr(expiredByDate.result, 'auth', 'account-expired');
  });

  it('sniffs HTML captive-portal responses on chunk 1 and cancels remaining stream immediately', async () => {
    let chunksRead = 0;
    let returned = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            chunksRead++;
            if (chunksRead === 1) return { done: false, value: enc('  <!DOCTYPE html><html>') };
            return { done: false, value: enc('x'.repeat(65536)) };
          },
          async return() {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const res = await collectGen(streamXtreamRecords(body));
    expectErr(res.result, 'source-format', 'invalid-json');
    expect(chunksRead).toBe(1);
    expect(returned).toBe(true);
  });

  it('enforces maxBodyBytes on raw input bytes and cancels iterator early', async () => {
    let chunksRead = 0;
    let returned = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            chunksRead++;
            if (chunksRead === 1) return { done: false, value: enc('[{"stream_id":1},') };
            if (chunksRead === 2) return { done: false, value: enc('{"stream_id":2}]') };
            return { done: true, value: undefined };
          },
          async return() {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const res = await collectGen(streamXtreamRecords(body, { maxBodyBytes: 20 }));
    expectErr(res.result, 'source-format', 'too-large');
    expect(chunksRead).toBe(2);
    expect(returned).toBe(true);
  });

  it('recovers PHP escapes, raw control chars, lone surrogates, trailing commas, and truncated trailing elements', async () => {
    const repaired =
      '\uFEFF[{"stream_id":1,"name":"King\\\'s \\uD83D\n\t\x00 News",},{"stream_id":2,"name":"Truncated';
    const res = await collectGen(
      streamXtreamRecords(chunksOf(enc(repaired), [3]), { batchSize: 1 }),
    );
    expect(res.result).toEqual(ok(undefined));
    expect(res.batches).toEqual([[{ stream_id: 1, name: "King's \ufffd\n\t News" }]]);

    const trailingCommaObj = await collectGen(
      streamXtreamRecords(chunksOf(enc('{"0":{"stream_id":7,"name":"Ok",},}'), [2])),
    );
    expect(trailingCommaObj.result).toEqual(ok(undefined));
    expect(trailingCommaObj.batches).toEqual([[{ stream_id: 7, name: 'Ok' }]]);

    const noCompleteObj = await collectGen(
      streamXtreamRecords(chunksOf(enc('[{"stream_id":1,"name":"Cut'), [3])),
    );
    expectErr(noCompleteObj.result, 'source-format', 'invalid-json');
  });

  it('decodes Windows-1254 Turkish and CP1252 single-byte fallback elements', async () => {
    // [{"stream_id":1,"name":"Şişli"},{"stream_id":2,"name":"€5"}]
    const head = enc('[{"stream_id":1,"name":"');
    const trBytes = new Uint8Array([0xde, 0x69, 0xfe, 0x6c, 0x69]); // Şişli in Windows-1254
    const mid = enc('"},{"stream_id":2,"name":"');
    const cp1252 = new Uint8Array([0x80, 0x35]); // €5 in CP1252
    const tail = enc('"}]');
    const all = new Uint8Array(
      head.length + trBytes.length + mid.length + cp1252.length + tail.length,
    );
    let o = 0;
    for (const part of [head, trBytes, mid, cp1252, tail]) {
      all.set(part, o);
      o += part.length;
    }

    const res = await collectGen(streamXtreamRecords(chunksOf(all, [1]), { batchSize: 10 }));
    expect(res.result).toEqual(ok(undefined));
    expect(res.batches.flat()).toEqual([
      { stream_id: 1, name: 'Şişli' },
      { stream_id: 2, name: '€5' },
    ]);
  });

  it('handles AbortSignal (closing pre-aborted bodies) and thrown stream errors cleanly', async () => {
    const ctl = new AbortController();
    ctl.abort();
    let returned = false;
    const preAbortedBody: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: enc('[{"stream_id":1}]') };
          },
          async return() {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const preAborted = await collectGen(
      streamXtreamRecords(preAbortedBody, { signal: ctl.signal }),
    );
    expectErr(preAborted.result, 'network', 'aborted');
    expect(returned).toBe(true);

    const throwing: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let count = 0;
        return {
          async next() {
            if (++count === 1) return { done: false, value: enc('[{"stream_id":1},') };
            throw elvError('network', 'timeout');
          },
        };
      },
    };
    const threw = await collectGen(streamXtreamRecords(throwing, { batchSize: 1 }));
    expect(threw.batches).toEqual([[{ stream_id: 1 }]]);
    expectErr(threw.result, 'network', 'timeout');
  });
});

describe('XtreamClient streaming methods', () => {
  it('streams mapped live, vod, and series batches with categoryId filter and batchSize', async () => {
    const urls: string[] = [];
    const http: HttpClient = {
      async get(url) {
        urls.push(url);
        const action = new URL(url).searchParams.get('action');
        const payload =
          action === 'get_live_streams'
            ? [
                { stream_id: 1, name: 'Ch 1', category_id: '10' },
                { stream_id: 2, name: 'Ch 2', category_id: '10' },
                { stream_id: 3, name: 'Ch 3', category_id: '10' },
              ]
            : action === 'get_vod_streams'
              ? [{ stream_id: 20, name: 'Film 1', category_id: '5', container_extension: 'mkv' }]
              : [{ series_id: 30, name: 'Show 1', category_id: '9', plot: 'Plot' }];
        return ok({ status: 200, headers: {}, body: chunksOf(enc(JSON.stringify(payload)), [9]) });
      },
    };
    const c = createXtreamClient({
      http,
      server: 'http://h.example',
      username: USER,
      password: PASS,
      rateLimit: false,
    });

    const live = await collectGen(c.streamLiveStreams('10', { batchSize: 2 }));
    expect(live.result).toEqual(ok(undefined));
    expect(live.batches).toHaveLength(2);
    expect(live.batches.flat().map((x) => x.id)).toEqual([1, 2, 3]);

    const vod = await collectGen(c.streamVodStreams(undefined, { batchSize: 5 }));
    expect(vod.result).toEqual(ok(undefined));
    expect(vod.batches.flat()).toMatchObject([{ id: 20, name: 'Film 1', extension: 'mkv' }]);

    const series = await collectGen(c.streamSeries('9', { batchSize: 5 }));
    expect(series.result).toEqual(ok(undefined));
    expect(series.batches.flat()).toMatchObject([{ id: 30, name: 'Show 1', plot: 'Plot' }]);

    expect(urls[0]).toContain('action=get_live_streams&category_id=10');
    expect(urls[1]).toContain('action=get_vod_streams');
    expect(urls[2]).toContain('action=get_series&category_id=9');
  });

  it('fails over to backup mirror on 5xx before first batch and shares 429 cooldown with getJson', async () => {
    let monoNow = 10_000;
    const hosts: string[] = [];
    let primaryStatus = 503;
    const http: HttpClient = {
      async get(url) {
        const host = new URL(url).host;
        hosts.push(host);
        if (host === 'primary.example') {
          return ok({
            status: primaryStatus,
            headers: primaryStatus === 429 ? { 'Retry-After': '30' } : {},
            body: (async function* () {})(),
          });
        }
        return ok({
          status: 200,
          headers: {},
          body: chunksOf(enc('[{"stream_id":1,"name":"Mirror Ch"}]'), [7]),
        });
      },
    };

    const c = createXtreamClient({
      http,
      server: 'http://primary.example',
      backupServers: ['http://backup1.example'],
      username: USER,
      password: PASS,
      rateLimit: { burst: 20, ratePerSec: 100, now: () => monoNow },
    });

    const first = await collectGen(c.streamLiveStreams(undefined, { batchSize: 2 }));
    expect(first.result).toEqual(ok(undefined));
    expect(first.batches.flat().map((x) => x.name)).toEqual(['Mirror Ch']);
    expect(hosts).toEqual(['primary.example', 'backup1.example']);

    // Force primary cooldown expiry + 429 -> must NOT fail over and must block subsequent getJson
    primaryStatus = 429;
    monoNow += 300_001;
    const second = await collectGen(c.streamVodStreams());
    expectErr(second.result, 'network', 'http-429');
    expect(hosts).toEqual(['primary.example', 'backup1.example', 'primary.example']);
    expectErr(await c.categories('live'), 'network', 'http-429');
    expect(hosts).toHaveLength(3);
  });

  it('discards response body if signal aborts while http.get resolves, and does not promote mirror on empty-mapped failing batch', async () => {
    // 1. Signal aborts during http.get resolution -> body.return() MUST be called
    const ctl = new AbortController();
    let bodyReturned = false;
    const abortHttp: HttpClient = {
      async get() {
        ctl.abort();
        return ok({
          status: 200,
          headers: {},
          body: {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  return { done: false, value: enc('[{"stream_id":1}]') };
                },
                async return() {
                  bodyReturned = true;
                  return { done: true, value: undefined };
                },
              };
            },
          },
        });
      },
    };
    const cAbort = createXtreamClient({
      http: abortHttp,
      server: 'http://h.example',
      username: USER,
      password: PASS,
      rateLimit: false,
    });
    expectErr(
      (await collectGen(cAbort.streamLiveStreams(undefined, { signal: ctl.signal }))).result,
      'network',
      'aborted',
    );
    expect(bodyReturned).toBe(true);

    // 2. Backup1 yields a batch that maps to [] (no valid stream_id) then throws stream error;
    //    backup2 also fails -> activeIndex must NOT have been promoted to backup1!
    const failHttp: HttpClient = {
      async get(url) {
        const host = new URL(url).host;
        if (host === 'primary.example') {
          return ok({ status: 503, headers: {}, body: (async function* () {})() });
        }
        if (host === 'backup1.example') {
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              yield enc('[{"name":"Missing ID"},');
              throw elvError('network', 'stream-failed');
            })(),
          });
        }
        return ok({ status: 502, headers: {}, body: (async function* () {})() });
      },
    };
    const cFail = createXtreamClient({
      http: failHttp,
      server: 'http://primary.example',
      backupServers: ['http://backup1.example', 'http://backup2.example'],
      username: USER,
      password: PASS,
      rateLimit: false,
    });
    expectErr(
      (await collectGen(cFail.streamLiveStreams(undefined, { batchSize: 1 }))).result,
      'network',
      'http-502',
    );
    expect(cFail.playlistUrl()).toContain('http://primary.example/get.php?');
  });
});
