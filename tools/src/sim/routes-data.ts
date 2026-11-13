import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { ACCOUNTS, type Account, findAccount } from './accounts.ts';
import { buildCatalog, type ProfileName } from './catalog.ts';
import { baseUrlOf, type RequestMeta, type RouteHandler, type SimContext } from './context.ts';
import { type M3uVariant, m3uChunks } from './m3u.ts';
import { pngLogo } from './png.ts';
import { xmltvChunks } from './xmltv.ts';
import { playerApi } from './xtream.ts';

const PLAYLISTS: Record<string, { profile: ProfileName; variant: M3uVariant }> = {
  small: { profile: 'small', variant: 'plain' },
  large: { profile: 'large', variant: 'plain' },
  compat: { profile: 'compat', variant: 'plain' },
  'compat-crlf-bom': { profile: 'compat', variant: 'crlf-bom' },
  'compat-truncated': { profile: 'compat', variant: 'truncated' },
};
const PROFILE_ACCOUNT: Record<ProfileName, string> = {
  small: 'demo',
  large: 'large',
  compat: 'compat',
};
const LOGO_COUNT = 16;

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
): Promise<void> {
  const headers: Record<string, string> = { 'content-type': type };
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
  const baseUrl = baseUrlOf(req, ctx);
  const catalog = buildCatalog(account.profile, ctx.seed);
  const guideUrl = `${baseUrl}/guides/${account.profile}.xml`;
  const chunks = m3uChunks(catalog, { baseUrl, account, output, guideUrl, variant });
  await sendChunks(res, 200, 'audio/x-mpegurl', chunks, false, false);
}

async function guide(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SimContext,
  profile: ProfileName,
  asFile: boolean,
): Promise<void> {
  const accepts = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  const chunks = xmltvChunks(buildCatalog(profile, ctx.seed), ctx.now(), baseUrlOf(req, ctx));
  if (asFile) return sendChunks(res, 200, 'application/gzip', chunks, true, false);
  const type = 'application/xml; charset=utf-8';
  return sendChunks(res, 200, type, chunks, accepts, true);
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
    if (path === '/xmltv.php') await guide(req, res, ctx, account.profile, false);
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

  const guideMatch = /^\/guides\/(small|large|compat)\.xml(\.gz)?$/.exec(path);
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
