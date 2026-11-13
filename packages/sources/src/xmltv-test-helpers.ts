import type { Decompressor } from '@elv/domain';
import { expect } from 'vitest';
import type { ScanStats } from './stats';
import { chunksOf, everySplit, utf8 } from './test-chunks';
import { scanXmltv, type XmltvChannel, type XmltvOptions, type XmltvProgramme } from './xmltv';

export interface Out {
  channels: XmltvChannel[];
  programmes: XmltvProgramme[];
  batches: number[];
  stats?: ScanStats;
  result?: unknown;
}

export async function collect(
  chunks: AsyncIterable<Uint8Array>,
  opts?: XmltvOptions,
): Promise<Out> {
  const out: Out = { channels: [], programmes: [], batches: [] };
  const gen = scanXmltv(chunks, opts);
  for (;;) {
    const r = await gen.next();
    if (r.done) {
      out.result = r.value;
      return out;
    }
    out.channels.push(...r.value.channels);
    out.programmes.push(...r.value.programmes);
    out.batches.push(r.value.programmes.length);
    if (r.value.stats) out.stats = r.value.stats;
  }
}

export const whole = (text: string): AsyncIterable<Uint8Array> => {
  const bytes = utf8(text);
  return chunksOf(bytes, [bytes.length]);
};

export async function expectSameEverywhere(text: string, opts?: XmltvOptions): Promise<Out> {
  const base = await collect(whole(text), opts);
  for (const split of everySplit(utf8(text))) {
    const r = await collect(split, opts);
    expect(r.channels).toEqual(base.channels);
    expect(r.programmes).toEqual(base.programmes);
    expect(r.stats?.warnings).toEqual(base.stats?.warnings);
  }
  return base;
}

export const D = (s: string): number =>
  Date.UTC(2026, 0, 1, Number(s.slice(0, 2)), Number(s.slice(2)));
export const guide = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="t">${body}</tv>\n`;

async function concat(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const gunzipper: Decompressor = {
  async *gunzip(chunks) {
    const data = await concat(chunks);
    const reader = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'))
      .getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) return;
      yield r.value;
    }
  },
};

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
