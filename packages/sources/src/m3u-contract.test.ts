import type { ElvError } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { type M3uBatch, scanM3u } from './m3u';
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

const last = (batches: M3uBatch[]) => batches[batches.length - 1] as M3uBatch;

describe('scanM3u non-playlist bodies', () => {
  it('turns an HTML page into skipped lines, not entries', async () => {
    const { batches } = await run(
      '<!DOCTYPE html>\n<html><body>\n<h1>Please log in</h1>\n</body></html>\n',
    );
    const done = last(batches);
    expect(done.entries).toEqual([]);
    expect(done.header?.present).toBe(false);
    expect(done.stats?.entries).toBe(0);
    expect(done.stats?.skipped).toBe(4);
    expect(done.stats?.warnings.every((w) => w.code === 'not-a-url')).toBe(true);
  });

  it('turns a JSON error into skipped lines', async () => {
    const { batches } = await run('{"user_info":{"auth":0}}\n');
    expect(last(batches).entries).toEqual([]);
    expect(last(batches).stats?.warnings).toEqual([{ code: 'not-a-url', line: 1 }]);
  });

  it('keeps real entries in a mixed file and reports the junk', async () => {
    const { batches } = await run(
      '#EXTM3U\n#EXTINF:-1,A\nhttp://h.example/1\nnot a url at all\n#EXTINF:-1,B\nrtmp://h.example/2\n',
    );
    const done = last(batches);
    expect(done.entries.map((e) => e.url)).toEqual(['http://h.example/1', 'rtmp://h.example/2']);
    expect(done.header?.present).toBe(true);
    expect(done.stats?.warnings).toEqual([{ code: 'not-a-url', line: 4 }]);
  });

  it('accepts relative references with a base URL unless they look like markup', async () => {
    const base = 'http://h.example/p/a.m3u';
    const ok = await run('#EXTINF:-1,A\nr/1.ts\n', { baseUrl: base });
    expect(last(ok.batches).entries[0]?.url).toBe('http://h.example/p/r/1.ts');
    const html = await run('<html>\n{"a":1}\nsome "words" here\n', { baseUrl: base });
    expect(last(html.batches).entries).toEqual([]);
    expect(last(html.batches).stats?.skipped).toBe(3);
  });
});

describe('scanM3u failure contract', () => {
  async function failing(error: unknown) {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield utf8('#EXTINF:-1,A\nhttp://h.example/1\n');
      throw error;
    }
    const gen = scanM3u(chunks(), { batchSize: 1 });
    const batches: M3uBatch[] = [];
    for (;;) {
      const r = await gen.next();
      if (r.done) return { batches, result: r.value };
      batches.push(r.value);
    }
  }

  it('returns ok after the final batch', async () => {
    const { batches, result } = await run('#EXTINF:-1,A\nhttp://h.example/1\n');
    expect(result).toEqual({ ok: true, value: undefined });
    expect(last(batches).done).toBe(true);
  });

  it('returns err for a throwing input, keeping ElvError-shaped errors', async () => {
    const own = await failing({ category: 'network', code: 'aborted' });
    expect(own.result).toEqual({ ok: false, error: { category: 'network', code: 'aborted' } });
    expect(own.batches.some((b) => b.done)).toBe(false);
    expect(own.batches[0]?.entries).toHaveLength(1);
    const plain = await failing(new Error('boom'));
    const error = (plain.result as { error: ElvError }).error;
    expect(error).toEqual({ category: 'network', code: 'stream-failed' });
  });
});

describe('scanM3u maps without a prototype', () => {
  it('stores __proto__, constructor and toString keys as plain data', async () => {
    const { batches } = await run(
      [
        '#EXTM3U __proto__="h" constructor="c" toString="t"',
        '#EXTINF:-1 __proto__="x" constructor="y" toString="z",A',
        '#KODIPROP:__proto__=k',
        '#KODIPROP:toString=k2',
        '#EXTHTTP:{"__proto__":"p","constructor":"q","toString":"r"}',
        'http://h.example/1',
        '',
      ].join('\n'),
    );
    const done = last(batches);
    const e = done.entries[0];
    expect(Object.getPrototypeOf(e?.extra)).toBeNull();
    expect(Object.keys(e?.extra ?? {}).sort()).toEqual(['__proto__', 'constructor', 'tostring']);
    expect(e?.extra.tostring).toBe('z');
    expect(Object.keys(e?.kodiProps ?? {}).sort()).toEqual(['__proto__', 'toString']);
    expect(Object.getPrototypeOf(e?.headers.other)).toBeNull();
    expect(Object.keys(e?.headers.other ?? {}).sort()).toEqual([
      '__proto__',
      'constructor',
      'tostring',
    ]);
    expect(Object.getPrototypeOf(done.header?.attrs)).toBeNull();
    expect(Object.keys(done.header?.attrs ?? {}).sort()).toEqual([
      '__proto__',
      'constructor',
      'tostring',
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
