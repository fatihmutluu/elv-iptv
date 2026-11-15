import { type HttpClient, ok } from '@elv/domain';
import { createXtreamClient, scanM3u, scanXmltv } from '@elv/sources';
import { ACCOUNTS, type Account } from '../../src/sim/accounts.ts';
import { createCatalog, type ProfileName } from '../../src/sim/catalog.ts';
import { m3uChunks } from '../../src/sim/m3u.ts';
import { xmltvChunks } from '../../src/sim/xmltv.ts';

declare const __ELV_BENCHMARK_PROFILE__: 'small' | 'large';
declare function print(line: string): void;

interface ThroughputMetrics {
  readonly bytes: number;
  readonly ms: number;
  readonly mbPerSec: number;
  readonly entries?: number;
  readonly channels?: number;
  readonly programmes?: number;
  readonly itemsPerSec: number;
}

export interface HermesRunPayload {
  readonly runtime: 'hermes' | 'other';
  readonly globals: Record<string, string>;
  readonly polyfillsNeeded: string[];
  readonly assertionsPassed: number;
  readonly benchmarkProfile: 'small' | 'large';
  readonly m3u: ThroughputMetrics;
  readonly xmltv: ThroughputMetrics;
}

function encodeUtf8(text: string): Uint8Array {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text);
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
  }
  return new Uint8Array(bytes);
}

async function* sliceEvery(bytes: Uint8Array, step: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += step) {
    yield bytes.subarray(i, Math.min(bytes.length, i + step));
  }
}

async function* streamChunks(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < chunks.length; i++) {
    yield chunks[i] as Uint8Array;
  }
}

let assertions = 0;
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Hermes assertion failed: ${message}`);
  assertions++;
}

async function verifyM3uCorrectness(): Promise<void> {
  const sample = [
    '\uFEFF#EXTM3U url-tvg="http://sim.invalid:7878/xmltv.xml"',
    '#EXTINF:-1 tvg-id="tr1" tvg-name="Kanal İğüşöçı" group-title="Sinema & Eğlence" catchup="default" catchup-days="3" catchup-source="?utc={utc}",Kanal İğüşöçı',
    '#EXTGRP:Alt Grup',
    '#EXTVLCOPT:http-user-agent=ELV-Hermes/1.0',
    '#EXTVLCOPT:http-referrer=http://sim.invalid:7878/ref',
    '#KODIPROP:inputstream.adaptive.license_type=clearkey',
    'relative/1001.ts',
    '#EXTINF:-1 tvg-id="q1" tvg-name="Channel "Raw", Quote" group-title="Movies",Sample Movie',
    'http://sim.invalid:7878/movie/demo/demo/200001.mkv',
    '#EXTINF:-1 group-title="Series",Show S01E02',
    'http://sim.invalid:7878/series/demo/demo/400001.mp4',
  ].join('\r\n');

  const entries = [];
  let headerUrl = '';
  for await (const step of scanM3u(sliceEvery(encodeUtf8(sample), 3), {
    baseUrl: 'http://sim.invalid:7878/lists/main.m3u',
    batchSize: 2,
  })) {
    if (step.header) headerUrl = step.header.guideUrls[0] ?? '';
    for (const e of step.entries) entries.push(e);
  }

  assert(headerUrl === 'http://sim.invalid:7878/xmltv.xml', 'M3U header url-tvg');
  assert(entries.length === 3, `expected 3 M3U entries, got ${entries.length}`);
  assert(entries[0]?.name === 'Kanal İğüşöçı', 'Turkish UTF-8 across 3-byte chunk boundaries');
  assert(entries[0]?.groups[0] === 'Sinema & Eğlence', 'group-title preserved');
  assert(entries[0]?.url === 'http://sim.invalid:7878/lists/relative/1001.ts', 'relative URL');
  assert(entries[0]?.headers.userAgent === 'ELV-Hermes/1.0', '#EXTVLCOPT user-agent');
  assert(entries[0]?.catchup?.days === 3, 'catchup-days');
  assert(entries[1]?.kindHint === 'movie', 'movie kindHint');
  assert(entries[2]?.kindHint === 'episode', 'episode kindHint');
}

async function verifyXmltvCorrectness(): Promise<void> {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv>',
    '<channel id="tr1"><display-name>Kanal &#x130;ğüşöçı &amp; HD</display-name></channel>',
    '<channel id="skip"><display-name>Ignored</display-name></channel>',
    '<programme start="20261113120000 +0300" stop="20261113130000 +0300" channel="tr1">',
    '<title>Özel Yayın &lt;Canlı&gt;</title>',
    '<desc><![CDATA[Açıklama <b>metni</b> & detaylar.]]></desc>',
    '<category>Haber</category>',
    '</programme>',
    '<programme start="20261113120000 +0000" stop="20261113130000 +0000" channel="skip"><title>No</title></programme>',
    '</tv>',
  ].join('\n');

  const allowed = new Set<string>(['tr1']);
  let channels = 0;
  let programmes = 0;
  let firstTitle = '';
  let firstDesc = '';
  for await (const step of scanXmltv(sliceEvery(encodeUtf8(xml), 5), {
    programmeChannels: allowed,
  })) {
    channels += step.channels.length;
    for (const p of step.programmes) {
      programmes++;
      firstTitle = p.title;
      firstDesc = p.desc ?? '';
    }
  }

  assert(channels === 2, `expected 2 XMLTV channels, got ${channels}`);
  assert(programmes === 1, `expected 1 filtered programme, got ${programmes}`);
  assert(firstTitle === 'Özel Yayın <Canlı>', 'XML entity + UTF-8 title');
  assert(firstDesc === 'Açıklama <b>metni</b> & detaylar.', 'CDATA description');
}

async function verifyXtreamCorrectness(): Promise<void> {
  const titleBytes = encodeUtf8('Kanal İğüşöçı — Özel Yayın');
  let bin = '';
  for (let i = 0; i < titleBytes.length; i++) bin += String.fromCharCode(titleBytes[i] as number);
  const titleB64 = btoa(bin);

  const http: HttpClient = {
    async get(url) {
      let payload: unknown = {};
      if (url.includes('action=get_short_epg')) {
        payload = {
          epg_listings: [
            {
              start_timestamp: '1700000000',
              stop_timestamp: '1700003600',
              title: titleB64,
              description: titleB64,
            },
          ],
        };
      } else if (url.includes('action=get_live_categories')) {
        payload = [{ category_id: '1', category_name: 'Ulusal Kanallar' }];
      } else {
        payload = {
          user_info: { auth: 1, status: 'Active', max_connections: '2' },
          server_info: { server_protocol: 'http', port: '8080' },
        };
      }
      return ok({
        status: 200,
        url,
        headers: {},
        body: sliceEvery(encodeUtf8(JSON.stringify(payload)), 7),
      });
    },
  };

  const client = createXtreamClient({
    server: 'sim.invalid:8080/player_api.php',
    username: 'demo',
    password: 'synthetic',
    http,
  });

  const acct = await client.account();
  assert(acct.ok && acct.value.maxConnections === 2, 'Xtream account parse');
  const cats = await client.categories('live');
  assert(cats.ok && cats.value[0]?.name === 'Ulusal Kanallar', 'Xtream categories parse');
  const epg = await client.shortEpg(1001, 4);
  assert(
    epg.ok && epg.value[0]?.title === 'Kanal İğüşöçı — Özel Yayın',
    'Xtream shortEpg base64 UTF-8 decode via atob',
  );
}

async function benchmarkProfile(
  profile: ProfileName,
): Promise<{ m3u: ThroughputMetrics; xmltv: ThroughputMetrics }> {
  const catalog = createCatalog(profile, 1);
  const account: Account = ACCOUNTS.find((a) => a.profile === profile) ?? (ACCOUNTS[0] as Account);

  const m3uBytes: Uint8Array[] = [];
  let m3uTotalBytes = 0;
  for (const chunk of m3uChunks(catalog, {
    baseUrl: 'http://sim.invalid:7878',
    account,
    output: 'ts',
    guideUrl: 'http://sim.invalid:7878/xmltv.xml',
    variant: 'plain',
  })) {
    const encoded = encodeUtf8(chunk);
    m3uBytes.push(encoded);
    m3uTotalBytes += encoded.byteLength;
  }

  const t0 = Date.now();
  let m3uEntries = 0;
  for await (const batch of scanM3u(streamChunks(m3uBytes))) {
    m3uEntries += batch.entries.length;
  }
  const m3uMs = Math.max(1, Date.now() - t0);

  const xmltvBytes: Uint8Array[] = [];
  let xmltvTotalBytes = 0;
  for (const chunk of xmltvChunks(
    catalog,
    new Date('2026-11-13T12:00:00Z'),
    'http://sim.invalid:7878',
    'plain',
  )) {
    const encoded = encodeUtf8(chunk);
    xmltvBytes.push(encoded);
    xmltvTotalBytes += encoded.byteLength;
  }

  const t1 = Date.now();
  let xmltvChannels = 0;
  let xmltvProgrammes = 0;
  for await (const batch of scanXmltv(streamChunks(xmltvBytes))) {
    xmltvChannels += batch.channels.length;
    xmltvProgrammes += batch.programmes.length;
  }
  const xmltvMs = Math.max(1, Date.now() - t1);

  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    m3u: {
      bytes: m3uTotalBytes,
      entries: m3uEntries,
      ms: m3uMs,
      mbPerSec: round2(m3uTotalBytes / (1024 * 1024) / (m3uMs / 1000)),
      itemsPerSec: Math.round(m3uEntries / (m3uMs / 1000)),
    },
    xmltv: {
      bytes: xmltvTotalBytes,
      channels: xmltvChannels,
      programmes: xmltvProgrammes,
      ms: xmltvMs,
      mbPerSec: round2(xmltvTotalBytes / (1024 * 1024) / (xmltvMs / 1000)),
      itemsPerSec: Math.round(xmltvProgrammes / (xmltvMs / 1000)),
    },
  };
}

async function main(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const runtime: 'hermes' | 'other' = typeof g.HermesInternal === 'object' ? 'hermes' : 'other';
  const globals: Record<string, string> = {
    atob: typeof g.atob,
    btoa: typeof g.btoa,
    TextDecoder: typeof g.TextDecoder,
    TextEncoder: typeof g.TextEncoder,
    URL: typeof g.URL,
    asyncIterator: typeof Symbol.asyncIterator,
  };
  const polyfillsNeeded: string[] = [];
  if (g.__ELV_POLYFILLED_ASYNC_ITERATOR__ === true) {
    polyfillsNeeded.push('Symbol.asyncIterator');
  }
  if (typeof g.atob !== 'function') polyfillsNeeded.push('atob');

  await verifyM3uCorrectness();
  await verifyXmltvCorrectness();
  await verifyXtreamCorrectness();

  const profile =
    typeof __ELV_BENCHMARK_PROFILE__ !== 'undefined' ? __ELV_BENCHMARK_PROFILE__ : 'small';
  const bench = await benchmarkProfile(profile);

  const payload: HermesRunPayload = {
    runtime,
    globals,
    polyfillsNeeded,
    assertionsPassed: assertions,
    benchmarkProfile: profile,
    m3u: bench.m3u,
    xmltv: bench.xmltv,
  };
  const emit = typeof print === 'function' ? print : (line: string) => console.log(line);
  emit(`ELV_HERMES_SOURCES ${JSON.stringify(payload)}`);
}

main().catch((err: unknown) => {
  const msg =
    err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
  const emit = typeof print === 'function' ? print : (line: string) => console.error(line);
  emit(`ELV_HERMES_ERROR ${msg}`);
  throw err;
});
