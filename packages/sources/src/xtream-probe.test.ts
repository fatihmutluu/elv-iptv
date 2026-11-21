import { err, type HttpClient, type HttpResponse, ok, type Result } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { utf8 } from './test-chunks';
import { createXtreamClient } from './xtream';
import { probeXtreamLiveFormat } from './xtream-probe';

function makeTsPacketBuffer(stride: 188 | 192 | 204, offset = 0, packets = 3): Uint8Array {
  const buf = new Uint8Array(offset + stride * packets);
  for (let p = 0; p < packets; p++) {
    const start = offset + p * stride;
    buf[start] = 0x47;
    buf[start + 1] = 0x40;
    buf[start + 2] = 0x00;
    buf[start + 3] = 0x10;
  }
  return buf;
}

interface MockStreamHandle {
  closed: boolean;
  chunksYielded: number;
  bytesYielded: number;
  body: AsyncIterable<Uint8Array>;
}

function makeTrackedBody(chunks: readonly Uint8Array[], infiniteAfter = false): MockStreamHandle {
  const handle: MockStreamHandle = {
    closed: false,
    chunksYielded: 0,
    bytesYielded: 0,
    body: undefined as unknown as AsyncIterable<Uint8Array>,
  };
  let idx = 0;
  const iterator: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async next() {
      if (handle.closed) return { done: true, value: undefined };
      if (idx < chunks.length) {
        const value = chunks[idx++] as Uint8Array;
        handle.chunksYielded++;
        handle.bytesYielded += value.length;
        return { done: false, value };
      }
      if (infiniteAfter) {
        const value = new Uint8Array(256);
        handle.chunksYielded++;
        handle.bytesYielded += value.length;
        return { done: false, value };
      }
      return { done: true, value: undefined };
    },
    async return() {
      handle.closed = true;
      return { done: true, value: undefined };
    },
  };
  handle.body = iterator;
  return handle;
}

function makeClient(http: HttpClient) {
  return createXtreamClient({
    http,
    server: 'http://panel.example:8080',
    username: 'u1',
    password: 'p1',
  });
}

describe('probeXtreamLiveFormat (#330)', () => {
  it('detects MPEG-TS at 188-, 192- (offset 0 and 4), and 204-byte strides and closes the stream immediately', async () => {
    for (const [stride, offset] of [
      [188, 0],
      [192, 0],
      [192, 4],
      [204, 0],
    ] as const) {
      const tsBytes = makeTsPacketBuffer(stride, offset, 3);
      const stream = makeTrackedBody([tsBytes.subarray(0, 200), tsBytes.subarray(200)], true);
      const urls: string[] = [];
      const http: HttpClient = {
        async get(url): Promise<Result<HttpResponse>> {
          urls.push(url);
          return ok({ status: 200, headers: {}, body: stream.body });
        },
      };
      const result = await probeXtreamLiveFormat({
        http,
        client: makeClient(http),
        streamIds: [101, 202],
      });
      expect(result).toBe('ts');
      expect(urls).toEqual(['http://panel.example:8080/live/u1/p1/101.ts']);
      expect(stream.closed).toBe(true);
      expect(stream.chunksYielded).toBeLessThanOrEqual(3);
    }
  });

  it('detects short MPEG-TS responses (< 188 bytes starting with 0x47) without mistaking ASCII text for TS', async () => {
    const shortTs = makeTrackedBody([new Uint8Array([0x47, 0x40, 0x00, 0x10, 0x00, 0x01])]);
    const httpTs: HttpClient = {
      async get() {
        return ok({ status: 200, headers: {}, body: shortTs.body });
      },
    };
    expect(
      await probeXtreamLiveFormat({
        http: httpTs,
        client: makeClient(httpTs),
        streamIds: [10],
      }),
    ).toBe('ts');
    expect(shortTs.closed).toBe(true);

    const gatewayText = makeTrackedBody([utf8('Gateway Timeout')]);
    const hlsBody = makeTrackedBody([utf8('#EXTM3U\n#EXT-X-VERSION:3\nseg1.ts\n')]);
    let calls = 0;
    const httpFallback: HttpClient = {
      async get() {
        calls++;
        return ok({
          status: 200,
          headers: {},
          body: calls === 1 ? gatewayText.body : hlsBody.body,
        });
      },
    };
    expect(
      await probeXtreamLiveFormat({
        http: httpFallback,
        client: makeClient(httpFallback),
        streamIds: [10],
      }),
    ).toBe('m3u8');
    expect(gatewayText.closed).toBe(true);
    expect(hlsBody.closed).toBe(true);
  });

  it('detects HLS playlists with leading BOM/whitespace or #EXT-X- tags and forwards custom headers', async () => {
    const receivedHeaders: Array<Readonly<Record<string, string>> | undefined> = [];
    const streams: MockStreamHandle[] = [];
    const http: HttpClient = {
      async get(url, options) {
        receivedHeaders.push(options?.headers);
        if (url.endsWith('.ts')) {
          return err({ category: 'network', code: 'http-404' });
        }
        const h = makeTrackedBody([utf8('\uFEFF  \n#EXTM3U\n#EXT-X-TARGETDURATION:6\n')]);
        streams.push(h);
        return ok({ status: 200, headers: {}, body: h.body });
      },
    };
    const result = await probeXtreamLiveFormat({
      http,
      client: makeClient(http),
      streamIds: [42],
      headers: { 'user-agent': 'ElvTV/1.0' },
    });
    expect(result).toBe('m3u8');
    expect(receivedHeaders).toEqual([{ 'user-agent': 'ElvTV/1.0' }, { 'user-agent': 'ElvTV/1.0' }]);
    expect(streams[0]?.closed).toBe(true);
  });

  it('probes at most 2 valid positive stream IDs (skipping invalid/duplicate IDs)', async () => {
    const urls: string[] = [];
    const http: HttpClient = {
      async get(url) {
        urls.push(url);
        return err({ category: 'network', code: 'http-502' });
      },
    };
    const result = await probeXtreamLiveFormat({
      http,
      client: makeClient(http),
      streamIds: [0, -1, Number.NaN, 1.5, 11, 11, 22, 33, 44],
    });
    expect(result).toBeUndefined();
    expect(urls).toEqual([
      'http://panel.example:8080/live/u1/p1/11.ts',
      'http://panel.example:8080/live/u1/p1/11.m3u8',
      'http://panel.example:8080/live/u1/p1/22.ts',
      'http://panel.example:8080/live/u1/p1/22.m3u8',
    ]);
  });

  it('enforces budgetMs and caller AbortSignal without lingering connections', async () => {
    let clock = 1000;
    const urls: string[] = [];
    const httpBudget: HttpClient = {
      async get(url) {
        urls.push(url);
        clock += 10_000;
        return err({ category: 'network', code: 'timeout' });
      },
    };
    const budgetRes = await probeXtreamLiveFormat({
      http: httpBudget,
      client: makeClient(httpBudget),
      streamIds: [1, 2],
      budgetMs: 15_000,
      now: () => clock,
    });
    expect(budgetRes).toBeUndefined();
    expect(urls).toHaveLength(2);

    const ac = new AbortController();
    ac.abort();
    let called = false;
    const httpAbort: HttpClient = {
      async get() {
        called = true;
        return err({ category: 'network', code: 'aborted' });
      },
    };
    expect(
      await probeXtreamLiveFormat({
        http: httpAbort,
        client: makeClient(httpAbort),
        streamIds: [1],
        signal: ac.signal,
      }),
    ).toBeUndefined();
    expect(called).toBe(false);
  });

  it('works with Hermes @@asyncIterator streams when Symbol.asyncIterator is undefined', async () => {
    const OriginalSymbol = globalThis.Symbol;
    const FakeSymbol = Object.assign(
      ((description?: string | number) => OriginalSymbol(description)) as typeof Symbol,
      {
        for: OriginalSymbol.for.bind(OriginalSymbol),
        keyFor: OriginalSymbol.keyFor.bind(OriginalSymbol),
        asyncIterator: undefined as unknown as typeof Symbol.asyncIterator,
      },
    );
    let closed = false;
    const babelBody = {
      '@@asyncIterator'() {
        let sent = false;
        return {
          next: async () => {
            if (sent) return { done: true as const, value: undefined };
            sent = true;
            return { done: false as const, value: utf8('#EXT-X-VERSION:3\n') };
          },
          return: async () => {
            closed = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    } as unknown as AsyncIterable<Uint8Array>;

    const http: HttpClient = {
      async get() {
        return ok({ status: 200, headers: {}, body: babelBody });
      },
    };
    (globalThis as { Symbol: typeof Symbol }).Symbol = FakeSymbol;
    try {
      const res = await probeXtreamLiveFormat({
        http,
        client: makeClient(http),
        streamIds: [7],
      });
      expect(res).toBe('m3u8');
      expect(closed).toBe(true);
    } finally {
      (globalThis as { Symbol: typeof Symbol }).Symbol = OriginalSymbol;
    }
  });

  it('handles unaligned TS sync, throwing http/body errors, and empty/non-media payloads safely', async () => {
    const unaligned = makeTsPacketBuffer(188, 37, 3);
    const unalignedStream = makeTrackedBody([unaligned]);
    const httpUnaligned: HttpClient = {
      async get() {
        return ok({ status: 200, headers: {}, body: unalignedStream.body });
      },
    };
    expect(
      await probeXtreamLiveFormat({
        http: httpUnaligned,
        client: makeClient(httpUnaligned),
        streamIds: [5],
      }),
    ).toBe('ts');
    expect(unalignedStream.closed).toBe(true);

    let closedErrBody = false;
    const throwingBody: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let step = 0;
        return {
          async next() {
            if (step++ === 0) return { done: false, value: utf8('#EXTM3U\n') };
            throw new Error('reset');
          },
          async return() {
            closedErrBody = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    let attempt = 0;
    const httpRecover: HttpClient = {
      async get() {
        attempt++;
        if (attempt === 1) throw new Error('socket hangup');
        return ok({ status: 200, headers: {}, body: throwingBody });
      },
    };
    expect(
      await probeXtreamLiveFormat({
        http: httpRecover,
        client: makeClient(httpRecover),
        streamIds: [9],
      }),
    ).toBe('m3u8');
    expect(closedErrBody).toBe(true);

    const htmlBody = makeTrackedBody([utf8('<html><body>Not Found</body></html>')]);
    const emptyBody = makeTrackedBody([]);
    let idx = 0;
    const httpUnknown: HttpClient = {
      async get() {
        return ok({ status: 200, headers: {}, body: idx++ === 0 ? htmlBody.body : emptyBody.body });
      },
    };
    expect(
      await probeXtreamLiveFormat({
        http: httpUnknown,
        client: makeClient(httpUnknown),
        streamIds: [1],
      }),
    ).toBeUndefined();
    expect(htmlBody.closed).toBe(true);
    expect(emptyBody.closed).toBe(true);

    expect(
      await probeXtreamLiveFormat({
        http: httpUnknown,
        client: makeClient(httpUnknown),
        streamIds: [],
      }),
    ).toBeUndefined();
    expect(
      await probeXtreamLiveFormat({
        http: httpUnknown,
        client: makeClient(httpUnknown),
        streamIds: [1],
        budgetMs: 0,
      }),
    ).toBeUndefined();
  });

  it('discards non-2xx response bodies, rejects UTF-8/1-byte G text & HTML echoing #EXT-X-, and enforces mid-chunk budget', async () => {
    const body404 = makeTrackedBody([utf8('#EXTM3U\n#EXT-X-VERSION:3\n')]);
    const body503 = makeTrackedBody([makeTsPacketBuffer(188, 0, 3)]);
    const bodyOk = makeTrackedBody([utf8('#EXTM3U\n#EXT-X-VERSION:3\n')]);
    let statusIdx = 0;
    const httpNon2xx: HttpClient = {
      async get() {
        const step = statusIdx++;
        if (step === 0) return ok({ status: 404, headers: {}, body: body404.body });
        if (step === 1) return ok({ status: 503, headers: {}, body: body503.body });
        return ok({ status: 200, headers: {}, body: bodyOk.body });
      },
    };
    expect(
      await probeXtreamLiveFormat({
        http: httpNon2xx,
        client: makeClient(httpNon2xx),
        streamIds: [10, 20],
      }),
    ).toBe('m3u8');
    expect(body404.closed).toBe(true);
    expect(body503.closed).toBe(true);
    expect(bodyOk.closed).toBe(true);

    // 1-byte 'G', UTF-8 error text starting with 'G', and HTML echoing '#EXT-X-' must NEVER match
    for (const badBytes of [
      new Uint8Array([0x47]),
      utf8('Gateway — 504'),
      utf8('Geçersiz istek'),
      utf8('<!doctype html><html><body>Missing #EXT-X-STREAM-INF header</body></html>'),
      utf8('<html><head><title>Error</title></head><body>\n#EXT-X-VERSION:3\n</body></html>'),
    ]) {
      const h = makeTrackedBody([badBytes]);
      const httpBad: HttpClient = {
        async get() {
          return ok({ status: 200, headers: {}, body: h.body });
        },
      };
      expect(
        await probeXtreamLiveFormat({
          http: httpBad,
          client: makeClient(httpBad),
          streamIds: [1],
        }),
      ).toBeUndefined();
      expect(h.closed).toBe(true);
    }

    // Mid-chunk budget exhaustion stops reading and closes body immediately
    let clock = 0;
    let slowClosed = false;
    let chunksRead = 0;
    const slowBody: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            chunksRead++;
            clock += 10_000;
            return { done: false, value: new Uint8Array(64) };
          },
          async return() {
            slowClosed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const httpSlow: HttpClient = {
      async get() {
        return ok({ status: 200, headers: {}, body: slowBody });
      },
    };
    expect(
      await probeXtreamLiveFormat({
        http: httpSlow,
        client: makeClient(httpSlow),
        streamIds: [1],
        budgetMs: 15_000,
        now: () => clock,
      }),
    ).toBeUndefined();
    expect(slowClosed).toBe(true);
    expect(chunksRead).toBe(2);
  });
});
