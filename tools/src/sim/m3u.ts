import type { Account } from './accounts.ts';
import type { Catalog, CompatCase, LiveChannel } from './catalog.ts';

/** File form of a playlist: as is, UTF-8 with BOM and CRLF line ends, or cut mid-attribute. */
export type M3uVariant = 'plain' | 'crlf-bom' | 'truncated';

/** Inputs that shape one rendering of a playlist. */
export interface M3uOptions {
  baseUrl: string;
  account: Account;
  output: 'ts' | 'm3u8';
  guideUrl: string;
  variant: M3uVariant;
}

const CHUNK_LIMIT = 60_000;
const COMPAT_BLANK_EVERY = 10;
const CLEARKEY = '0123456789abcdef0123456789abcdef:fedcba9876543210fedcba9876543210';
const CATCHUP_TEMPLATE =
  `start=\${start}&end=\${end}&utc=\${utc}&lutc=\${lutc}&ts=\${timestamp}&dur=\${duration}&off=\${offset}` +
  '&u2={utc}&s2={start}&ymd={Y}-{m}-{d}';

/** Xtream-style stream URL for a catalog item. */
export function streamUrl(
  baseUrl: string,
  account: Account,
  kind: 'live' | 'movie' | 'series',
  id: number,
  ext: string,
): string {
  return `${baseUrl}/${kind}/${account.username}/${account.password}/${id}.${ext}`;
}

interface Ctx {
  base: string;
  account: Account;
  ext: string;
}

interface Extras {
  attrs: string;
  directives: string[];
  url?: string;
}

function compatExtras(c: CompatCase, ch: LiveChannel, ctx: Ctx): Extras {
  const { base, account } = ctx;
  const days = `catchup-days="${ch.archiveDays}"`;
  switch (c) {
    case 'tvg-shift':
      return { attrs: ' tvg-shift="-2"', directives: [] };
    case 'tvg-rec':
      return { attrs: ' tvg-rec="3"', directives: [] };
    case 'radio':
      return { attrs: ' radio="true"', directives: [] };
    case 'catchup-default':
      return {
        attrs: ` catchup="default" ${days} catchup-source="${base}/catchup/${ch.id}.ts?case=default&${CATCHUP_TEMPLATE}"`,
        directives: [],
      };
    case 'catchup-append':
      return {
        attrs: ' catchup="append" catchup-source="?case=append&utc={utc}&lutc={lutc}"',
        directives: [],
      };
    case 'catchup-shift':
    case 'catchup-flussonic':
    case 'catchup-flussonic-hls':
    case 'catchup-fs':
    case 'catchup-xc':
      return { attrs: ` catchup="${c.slice('catchup-'.length)}" ${days}`, directives: [] };
    case 'extgrp':
      return { attrs: '', directives: ['#EXTGRP:Compat Group'] };
    case 'vlcopt-user-agent':
      return { attrs: '', directives: ['#EXTVLCOPT:http-user-agent=ELV-Compat-UA/1.0'] };
    case 'vlcopt-referrer':
      return { attrs: '', directives: [`#EXTVLCOPT:http-referrer=${base}/referrer-check`] };
    case 'exthttp':
      return { attrs: '', directives: ['#EXTHTTP:{"User-Agent":"ELV-Compat-UA/2.0"}'] };
    case 'kodiprop-clearkey':
      return {
        attrs: '',
        directives: [
          '#KODIPROP:inputstream.adaptive.manifest_type=mpd',
          '#KODIPROP:inputstream.adaptive.license_type=clearkey',
          `#KODIPROP:inputstream.adaptive.license_key=${CLEARKEY}`,
        ],
      };
    case 'relative-url':
      return { attrs: '', directives: [], url: `relative/${ch.id}.ts` };
    case 'redirect-url':
      return { attrs: '', directives: [], url: `${base}/redirect/${ch.id}.ts` };
    case 'credentials-in-url':
      return {
        attrs: '',
        directives: [],
        url: `http://${account.username}:${account.password}@${new URL(base).host}/live/${account.username}/${account.password}/${ch.id}.ts`,
      };
    case 'udp-url':
      return { attrs: '', directives: [], url: 'udp://@239.0.0.1:1234' };
    case 'rtp-url':
      return { attrs: '', directives: [], url: 'rtp://@239.0.0.2:5004' };
    case 'rtmp-url':
      return { attrs: '', directives: [], url: `rtmp://127.0.0.1:1935/live/${ch.id}` };
    case 'missing-404':
      return {
        attrs: '',
        directives: [],
        url: `${base}/live/${account.username}/${account.password}/999999.ts`,
      };
    default:
      return { attrs: '', directives: [] };
  }
}

function liveTvgId(ch: LiveChannel): string | null {
  if (ch.compat === 'duplicate-id-a' || ch.compat === 'duplicate-id-b') return 'dup';
  return ch.epgId;
}

function* liveLines(catalog: Catalog, ctx: Ctx, groups: Map<string, string>): Generator<string> {
  for (let i = 0; i < catalog.live.length; i++) {
    const ch = catalog.live[i] as LiveChannel;
    if (catalog.profile === 'compat' && i > 0 && i % COMPAT_BLANK_EVERY === 0) yield '';
    const extras = ch.compat ? compatExtras(ch.compat, ch, ctx) : { attrs: '', directives: [] };
    const tvgId = liveTvgId(ch);
    const logo = ch.logo === null ? '' : ` tvg-logo="${ctx.base}/logos/${ch.logo}.png"`;
    yield `#EXTINF:-1${tvgId === null ? '' : ` tvg-id="${tvgId}"`} tvg-name="${ch.name}"${logo} tvg-chno="${ch.num}"${extras.attrs} group-title="${groups.get(ch.categoryId)}",${ch.name}`;
    yield* extras.directives;
    yield extras.url ?? streamUrl(ctx.base, ctx.account, 'live', ch.id, ctx.ext);
  }
}

function* vodLines(catalog: Catalog, ctx: Ctx, groups: Map<string, string>): Generator<string> {
  for (const m of catalog.movies) {
    yield `#EXTINF:-1 tvg-name="${m.name}" group-title="${groups.get(m.categoryId)}",${m.name}`;
    yield streamUrl(ctx.base, ctx.account, 'movie', m.id, m.ext);
  }
  for (const s of catalog.series) {
    for (const e of s.episodes) {
      yield `#EXTINF:-1 tvg-name="${e.title}" group-title="${groups.get(s.categoryId)}",${e.title}`;
      yield streamUrl(ctx.base, ctx.account, 'series', e.id, e.ext);
    }
  }
}

function* playlistLines(catalog: Catalog, opts: M3uOptions): Generator<string> {
  const ctx: Ctx = { base: opts.baseUrl, account: opts.account, ext: opts.output };
  const groups = new Map(catalog.categories.map((c) => [c.id, c.name]));
  const compat = catalog.profile === 'compat';
  yield `#EXTM3U url-tvg="${opts.guideUrl}"${compat ? ` x-tvg-url="${opts.guideUrl}"` : ''}`;
  if (compat) yield '# compat fixture';
  yield* liveLines(catalog, ctx, groups);
  yield* vodLines(catalog, ctx, groups);
}

/** Cuts an EXTINF line inside its last attribute, as a download that stopped early would. */
function cutMidAttribute(extinf: string): string {
  const marker = 'group-title="';
  const at = extinf.lastIndexOf(marker);
  return at < 0 ? extinf.slice(0, extinf.length >> 1) : extinf.slice(0, at + marker.length + 2);
}

/** Like `playlistLines`, but the last entry is cut mid-attribute and nothing follows it. */
function* truncatedLines(lines: Generator<string>): Generator<string> {
  let held: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      if (held) yield* held;
      held = [line];
    } else if (held) held.push(line);
    else yield line;
  }
  if (held) yield cutMidAttribute(held[0] as string);
}

/** Yields the playlist in chunks of at most ~64 KB; never builds the whole text. */
export function* m3uChunks(catalog: Catalog, opts: M3uOptions): Generator<string> {
  const eol = opts.variant === 'crlf-bom' ? '\r\n' : '\n';
  const truncated = opts.variant === 'truncated';
  const lines = truncated
    ? truncatedLines(playlistLines(catalog, opts))
    : playlistLines(catalog, opts);
  let buffer = opts.variant === 'crlf-bom' ? '\uFEFF' : '';
  let pending: string | null = null;
  for (const line of lines) {
    if (pending !== null) buffer += pending + eol;
    pending = line;
    if (buffer.length >= CHUNK_LIMIT) {
      yield buffer;
      buffer = '';
    }
  }
  if (pending !== null) buffer += truncated ? pending : pending + eol;
  if (buffer !== '') yield buffer;
}
