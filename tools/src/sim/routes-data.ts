import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { ACCOUNTS, type Account, findAccount } from './accounts.ts';
import { buildCatalog, type ProfileName } from './catalog.ts';
import { baseUrlOf, type RequestMeta, type RouteHandler, type SimContext } from './context.ts';
import { type M3uVariant, m3uChunks } from './m3u.ts';
import { pngLogo } from './png.ts';
import { type GuideStyle, xmltvChunks } from './xmltv.ts';
import { playerApi } from './xtream.ts';

const PLAYLISTS: Record<string, { profile: ProfileName; variant: M3uVariant }> = {
  small: { profile: 'small', variant: 'plain' },
  large: { profile: 'large', variant: 'plain' },
  compat: { profile: 'compat', variant: 'plain' },
  'compat-crlf-bom': { profile: 'compat', variant: 'crlf-bom' },
  'compat-truncated': { profile: 'compat', variant: 'truncated' },
  huge: { profile: 'huge', variant: 'plain' },
  corpus: { profile: 'corpus', variant: 'plain' },
};
const PROFILE_ACCOUNT: Record<ProfileName, string> = {
  small: 'demo',
  large: 'large',
  compat: 'compat',
  huge: 'huge',
  corpus: 'corpus',
};
const LOGO_COUNT = 16;
const DAY_MS = 86_400_000;
const PLAYLIST_EPOCH_MS = Date.UTC(2025, 0, 1);

interface CacheValidator {
  etag: string;
  lastModified: string;
  lastModifiedMs: number;
}

function makeValidator(
  keyParts: readonly (string | number)[],
  lastModifiedMs: number,
  weak = false,
): CacheValidator {
  const digest = createHash('sha256').update(keyParts.join('|')).digest('hex').slice(0, 16);
  const roundedMs = Math.floor(lastModifiedMs / 1000) * 1000;
  return {
    etag: `${weak ? 'W/' : ''}"elv-${digest}"`,
    lastModified: new Date(roundedMs).toUTCString(),
    lastModifiedMs: roundedMs,
  };
}

function headerText(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : value;
}

function stripWeak(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

function parseEntityTags(header: string): string[] {
  const tags: string[] = [];
  let i = 0;
  const len = header.length;
  while (i < len) {
    while (i < len && (header[i] === ' ' || header[i] === '\t' || header[i] === ',')) i++;
    if (i >= len) break;
    const start = i;
    let inQuotes = false;
    while (i < len) {
      const ch = header[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ',' && !inQuotes) break;
      i++;
    }
    const token = header.slice(start, i).trim();
    if (token !== '') tags.push(token);
  }
  return tags;
}

function isNotModified(req: IncomingMessage, validator: CacheValidator): boolean {
  const ifNoneMatch = headerText(req.headers['if-none-match']);
  if (ifNoneMatch !== undefined) {
    const target = stripWeak(validator.etag);
    for (const token of parseEntityTags(ifNoneMatch)) {
      if (token === '*' || stripWeak(token) === target) return true;
    }
    return false;
  }
  const ifModifiedSince = headerText(req.headers['if-modified-since']);
  if (ifModifiedSince === undefined) return false;
  const imsMs = Date.parse(ifModifiedSince);
  if (Number.isNaN(imsMs)) return false;
  return Math.floor(validator.lastModifiedMs / 1000) <= Math.floor(imsMs / 1000);
}

function sendNotModified(res: ServerResponse, validator: CacheValidator, varyGzip: boolean): void {
  const headers: Record<string, string> = {
    etag: validator.etag,
    'last-modified': validator.lastModified,
  };
  if (varyGzip) headers.vary = 'accept-encoding';
  res.writeHead(304, headers);
  res.end();
}

/** Sends a complete small response. */
export function sendText(res: ServerResponse, status: number, type: string, body = ''): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** Streams generator chunks to the response, honouring backpressure, optionally gzipped. */
async function sendChunks(
  res: ServerResponse,
  status: number,
  type: string,
  chunks: Iterable<string>,
  gzip: boolean,
  encoded: boolean,
  validator?: CacheValidator,
): Promise<void> {
  const headers: Record<string, string> = { 'content-type': type };
  if (validator) {
    headers.etag = validator.etag;
    headers['last-modified'] = validator.lastModified;
  }
  if (gzip && encoded) headers['content-encoding'] = 'gzip';
  if (gzip) headers.vary = 'accept-encoding';
  res.writeHead(status, headers);
  const source = Readable.from(chunks, { objectMode: false });
  await (gzip ? pipeline(source, createGzip(), res) : pipeline(source, res));
}

function accountFor(profile: ProfileName): Account {
  const name = PROFILE_ACCOUNT[profile];
  const account = ACCOUNTS.find((a) => a.username === name);
  if (!account) throw new Error(`no account for profile ${profile}`);
  return account;
}

async function playlist(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SimContext,
  account: Account,
  variant: M3uVariant,
  output: 'ts' | 'm3u8',
): Promise<void> {
  const validator = makeValidator(
    [ctx.seed, 'playlist', account.profile, account.username, variant, output],
    PLAYLIST_EPOCH_MS + ((ctx.seed >>> 0) % 365) * DAY_MS,
  );
  if (isNotModified(req, validator)) {
    sendNotModified(res, validator, false);
    return;
  }
  const baseUrl = baseUrlOf(req, ctx);
  const catalog = buildCatalog(account.profile, ctx.seed);
  const guideUrl = `${baseUrl}/guides/${account.profile}.xml`;
  const chunks = m3uChunks(catalog, { baseUrl, account, output, guideUrl, variant });
  await sendChunks(res, 200, 'audio/x-mpegurl', chunks, false, false, validator);
}

async function guide(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SimContext,
  profile: ProfileName,
  asFile: boolean,
  style: GuideStyle = 'plain',
): Promise<void> {
  const now = ctx.now();
  const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayBucket = new Date(dayStartMs).toISOString().slice(0, 10);
  const validator = makeValidator(
    [ctx.seed, 'guide', profile, style, asFile ? 'gz' : 'xml', dayBucket],
    dayStartMs,
    !asFile,
  );
  const accepts = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  if (isNotModified(req, validator)) {
    sendNotModified(res, validator, asFile || accepts);
    return;
  }
  const chunks = xmltvChunks(buildCatalog(profile, ctx.seed), now, baseUrlOf(req, ctx), style);
  if (asFile) return sendChunks(res, 200, 'application/gzip', chunks, true, false, validator);
  const type = 'application/xml; charset=utf-8';
  return sendChunks(res, 200, type, chunks, accepts, true, validator);
}

function setAccount(meta: RequestMeta, username: string | null): void {
  if (username !== null && ACCOUNTS.some((a) => a.username === username)) meta.account = username;
}

/** Playlists, the Xtream-compatible API, guides and logos. */
export const dataRoute: RouteHandler = async (req, res, ctx, meta) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = new URL(req.url ?? '/', 'http://sim');
  const path = url.pathname;
  const q = url.searchParams;

  if (path === '/get.php' || path === '/player_api.php' || path === '/xmltv.php') {
    setAccount(meta, q.get('username'));
    if (path === '/player_api.php') {
      const result = playerApi(q, { baseUrl: baseUrlOf(req, ctx), now: ctx.now(), seed: ctx.seed });
      sendText(res, result.status, 'application/json', JSON.stringify(result.body));
      return true;
    }
    const account = findAccount(q.get('username'), q.get('password'));
    if (!account) {
      sendText(res, 401, 'text/plain');
      return true;
    }
    if (path === '/xmltv.php')
      await guide(req, res, ctx, account.profile, false, account.quirks ? 'panel' : 'plain');
    else {
      const output = q.get('output') === 'ts' || q.get('output') === null ? 'ts' : 'm3u8';
      await playlist(req, res, ctx, account, 'plain', output);
    }
    return true;
  }

  const broken = /^\/playlists\/broken\/(\d{3})\.m3u8?$/.exec(path);
  if (broken) {
    const status = Number(broken[1]);
    if (status < 100 || status > 599) return false;
    sendText(res, status, 'text/plain');
    return true;
  }

  const direct = /^\/playlists\/([a-z-]+)\.m3u8?$/.exec(path);
  if (direct) {
    const entry = PLAYLISTS[direct[1] as string];
    if (!entry) return false;
    setAccount(meta, PROFILE_ACCOUNT[entry.profile]);
    await playlist(req, res, ctx, accountFor(entry.profile), entry.variant, 'ts');
    return true;
  }

  const guideMatch = /^\/guides\/(small|large|compat|huge|corpus)\.xml(\.gz)?$/.exec(path);
  if (guideMatch) {
    await guide(req, res, ctx, guideMatch[1] as ProfileName, guideMatch[2] !== undefined);
    return true;
  }

  const logo = /^\/logos\/(\d{1,2})\.png$/.exec(path);
  if (logo && Number(logo[1]) < LOGO_COUNT) {
    const png = pngLogo(Number(logo[1]));
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    res.end(png);
    return true;
  }
  return false;
};
