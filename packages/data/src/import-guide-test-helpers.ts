import { type Decompressor, elvError, type HttpClient, ok } from '@elv/domain';
import { setupM3u } from './import-test-helpers';

/** Fixed "now" of the guide tests: 2026-11-13 12:00 UTC. */
export const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

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
