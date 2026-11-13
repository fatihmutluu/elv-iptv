import { type Decompressor, elvError, type HttpClient, ok } from '@elv/domain';
import { expect } from 'vitest';
import { importGuide } from './import-guide';
import { extinf, M3U_TOKEN, setupM3u } from './import-test-helpers';
import { importCatalog } from './import-xtream';
import { getSource } from './sources';

/** Fixed "now" of the guide tests: 2026-11-13 12:00 UTC. */
export const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
export const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** XMLTV timestamp (UTC) for an epoch offset from {@link NOW}. */
export function xt(offsetMs: number): string {
  const d = new Date(NOW + offsetMs);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
}

export const channelXml = (id: string, ...names: string[]): string =>
  `<channel id="${id}">${names.map((n) => `<display-name>${n}</display-name>`).join('')}</channel>`;

export const programmeXml = (channel: string, startOffset: number, hours: number, title: string) =>
  `<programme start="${xt(startOffset)}" stop="${xt(startOffset + hours * HOUR)}" channel="${channel}"><title>${title}</title><desc>About ${title}</desc><category>News</category></programme>`;

export const tv = (...parts: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<tv>${parts.join('\n')}</tv>`;

export const GUIDE_URL = 'http://epg.example/guide.xml';
const SECOND_URL = 'http://epg2.example/other.xml';

export { SECOND_URL };

interface GuideServer {
  body: string | Uint8Array;
  status: number;
  /** Per-URL status overrides. */
  statuses: Map<string, number>;
  failAfter: number | undefined;
  chunk: number;
  urls: string[];
}

/** Serves `server.body` for every URL under `epg*.example` and the playlist for everything else. */
export async function setupGuide(
  playlist: string,
  input: Parameters<typeof setupM3u>[1] = { guideUrl: GUIDE_URL },
) {
  const e = await setupM3u(playlist, input);
  const server: GuideServer = {
    body: tv(),
    status: 200,
    statuses: new Map(),
    failAfter: undefined,
    chunk: 64,
    urls: [],
  };
  const playlistHttp = e.deps.http;
  const http: HttpClient = {
    async get(url, options) {
      if (!url.includes('.example/') || !url.includes('epg')) return playlistHttp.get(url, options);
      server.urls.push(url);
      const bytes =
        typeof server.body === 'string' ? new TextEncoder().encode(server.body) : server.body;
      const status = server.statuses.get(url) ?? server.status;
      async function* chunks() {
        for (let i = 0; i < bytes.length; i += server.chunk) {
          if (server.failAfter !== undefined && i >= server.failAfter) {
            throw elvError('network', 'timeout');
          }
          if (options?.signal?.aborted) throw elvError('network', 'aborted');
          yield bytes.slice(i, i + server.chunk);
        }
      }
      return ok({ status, headers: {}, body: chunks() });
    },
  };
  const deps = { ...e.deps, http };
  return { ...e, deps, server };
}

/** Test decompressor: the "gzip" payload is the XML behind the two magic bytes. */
export const fakeGunzip: Decompressor = {
  async *gunzip(chunks) {
    let skip = 2;
    for await (const chunk of chunks) {
      yield skip > 0 ? chunk.subarray(Math.min(skip, chunk.length)) : chunk;
      skip = Math.max(0, skip - chunk.length);
    }
  },
};

export const gzipped = (xml: string): Uint8Array => {
  const body = new TextEncoder().encode(xml);
  const out = new Uint8Array(body.length + 2);
  out.set([0x1f, 0x8b]);
  out.set(body, 2);
  return out;
};

export type Env = Awaited<ReturnType<typeof setupGuide>>;

export const stream = (id: number) => `http://cdn.example:8080/${M3U_TOKEN}/hb/s/${id}.ts`;
export const PLAYLIST =
  '#EXTM3U\n' +
  extinf('Haber Bir', stream(1), 'tvg-id="haber1.tr"') +
  extinf('Haber Bir HD', stream(2), 'tvg-id="haber1.tr"') +
  extinf('Çağrı TV', stream(3), '') +
  extinf('Ikiz', stream(4), '') +
  extinf('Ikiz', stream(5), '') +
  extinf('Quiet', stream(6), 'tvg-id="quiet.tr"');

export const rows = (e: Env, sql: string, p: (string | number)[] = []) =>
  e.db.all<Record<string, unknown>>(sql, p);
export const settings = async (e: Env) => (await getSource(e.db, e.sourceId))?.settings ?? {};
export const titles = async (e: Env) =>
  (await rows(e, 'SELECT title FROM programmes ORDER BY start, guide_id')).map((p) => p.title);
export const lastGuideRun = async (e: Env) =>
  (await rows(e, "SELECT status FROM import_runs WHERE kind = 'guide' ORDER BY id DESC"))[0]
    ?.status;

export function defaultGuide(): string {
  return tv(
    channelXml('haber1.tr', 'Haber Bir'),
    channelXml('cagri', 'ÇAĞRI TV'),
    channelXml('ikiz', 'Ikiz'),
    channelXml('nobody', 'Nobody'),
    programmeXml('haber1.tr', -2 * DAY, 1, 'Too Old'),
    programmeXml('haber1.tr', -2 * HOUR, 1, 'Ended'),
    programmeXml('haber1.tr', -HOUR / 2, 1, 'Running'),
    programmeXml('haber1.tr', 2 * HOUR, 1, 'Later'),
    programmeXml('haber1.tr', 6 * DAY, 1, 'Next Week'),
    programmeXml('haber1.tr', 9 * DAY, 1, 'Too Far'),
    programmeXml('cagri', 3 * HOUR, 2, 'Named Match'),
    programmeXml('ikiz', 4 * HOUR, 2, 'Ambiguous'),
    programmeXml('nobody', 5 * HOUR, 2, 'Unmapped'),
  );
}

export async function ready(guide = defaultGuide()): Promise<Env> {
  const e = await setupGuide(PLAYLIST);
  const r = await importCatalog(e.sourceId, e.deps);
  if (!r.ok) throw new Error('catalog setup failed');
  e.server.body = guide;
  return e;
}

export const run = (e: Env, opts = {}) => importGuide(e.sourceId, e.deps, { now: NOW, ...opts });

export function expectErr(
  r: { ok: boolean; error?: { category: string; code: string } },
  category: string,
  code: string,
) {
  if (r.ok || r.error === undefined) throw new Error('expected error');
  expect(r.error.category).toBe(category);
  expect(r.error.code).toBe(code);
}
