import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ACCOUNTS, type Account } from './accounts.ts';
import { buildCatalog, type RecipeName } from './catalog.ts';
import { baseUrlOf, type RequestMeta, type RouteHandler, type SimContext } from './context.ts';
import { ALL_RECIPES, spawnLive } from './media.ts';
import { sendText } from './routes-data.ts';
import {
  authorize,
  loadRecipe,
  pipeFaulted,
  resolveFaults,
  sendFile,
  takeSlot,
} from './stream-io.ts';

const LIVE = /^\/live\/([^/]+)\/([^/]+)\/(\d+)(?:\.(ts|m3u8))?$/;
const SHORT = /^\/([^/]+)\/([^/]+)\/(\d+)$/;
const HLS_SEGMENT = /^\/hls\/([^/]+)\/(\d+)\.ts$/;
const TIMESHIFT = /^\/timeshift\/([^/]+)\/([^/]+)\/[^/]+\/[^/]+\/(\d+)\.ts$/;
const CATCHUP = /^\/catchup\/(\d+)\.ts$/;
const REDIRECT = /^\/redirect\/(\d+)\.ts$/;
const RELATIVE = /\/relative\/(\d+)\.ts$/;
const FLUSSONIC = /(archive-|index-|timeshift_abs-)/;
const LEADING_ID = /^\/(\d+)\//;

const DEFAULT_RECIPE: RecipeName = 'h264-aac-720p25';
const HLS_EPOCH_MS = Date.UTC(2026, 0, 1);
const HLS_WINDOW = 6;
const HLS_SEGMENT_MS = 2000;

function liveChannel(account: Account, seed: number, id: number) {
  return buildCatalog(account.profile, seed).live.find((c) => c.id === id) ?? null;
}

/**
 * Sliding-window media playlist for `nowMs`. Discontinuity tags precede segments whose index wraps to 0
 * (seq > 0, multiple of `segmentCount`); the discontinuity sequence counts those that left the window.
 */
export function hlsPlaylist(recipe: RecipeName, segmentCount: number, nowMs: number): string {
  const first = Math.max(0, Math.floor((nowMs - HLS_EPOCH_MS) / HLS_SEGMENT_MS));
  const wraps = first > 0 ? Math.floor((first - 1) / segmentCount) : 0;
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${wraps}`,
  ];
  for (let seq = first; seq < first + HLS_WINDOW; seq++) {
    if (seq > 0 && seq % segmentCount === 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push('#EXTINF:2.000,', `/hls/${recipe}/${seq}.ts`);
  }
  return `${lines.join('\n')}\n`;
}

async function serveLive(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SimContext,
  meta: RequestMeta,
  account: Account,
  id: number,
  playlist: boolean,
): Promise<void> {
  meta.streamId = id;
  const channel = liveChannel(account, ctx.seed, id);
  if (!channel) {
    sendText(res, 404, 'text/plain', 'not found');
    return;
  }
  meta.recipe = channel.recipe;
  const faults = await resolveFaults(req, res, meta, channel.fault);
  if (faults === null) return;
  const files = await loadRecipe(res, ctx, channel.recipe);
  if (files === null) return;
  if (playlist) {
    const body = hlsPlaylist(channel.recipe, files.segmentCount, ctx.now().getTime());
    sendText(res, 200, 'application/vnd.apple.mpegurl', body);
    return;
  }
  const ffmpeg = ctx.media?.ffmpeg;
  if (!ffmpeg || !takeSlot(res, ctx, account)) return;
  res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const live = spawnLive(ffmpeg, files.loopTs);
  res.once('close', live.stop);
  await pipeFaulted(res, live.stdout, faults);
  live.stop();
}

async function serveHlsSegment(
  res: ServerResponse,
  ctx: SimContext,
  meta: RequestMeta,
  recipe: RecipeName,
  seq: number,
): Promise<void> {
  meta.recipe = recipe;
  const files = await loadRecipe(res, ctx, recipe);
  if (files === null) return;
  const index = String(seq % files.segmentCount).padStart(5, '0');
  const file = `${files.segmentsDir}/seg${index}.ts`;
  res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': statSync(file).size });
  await pipeFaulted(res, createReadStream(file), []);
}

async function serveRecorded(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SimContext,
  meta: RequestMeta,
  account: Account | null,
): Promise<void> {
  meta.recipe = DEFAULT_RECIPE;
  const faults = await resolveFaults(req, res, meta, null);
  if (faults === null) return;
  const files = await loadRecipe(res, ctx, DEFAULT_RECIPE);
  if (files === null) return;
  await sendFile(req, res, ctx, { file: files.vodMp4, type: 'video/mp4', account, faults });
}

/** Live TS and HLS, catch-up answers, redirects and the connection limit for live streams. */
export const liveRoute: RouteHandler = async (req, res, ctx, meta) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = new URL(req.url ?? '/', 'http://sim');
  const path = url.pathname;

  const redirect = REDIRECT.exec(path);
  if (redirect) {
    const compat = ACCOUNTS.find((a) => a.profile === 'compat');
    if (!compat) return false;
    meta.account = compat.username;
    meta.streamId = Number(redirect[1]);
    const target = `${baseUrlOf(req, ctx)}/live/${compat.username}/${compat.password}/${redirect[1]}.ts`;
    res.writeHead(302, { location: target });
    res.end();
    return true;
  }

  const live = LIVE.exec(path) ?? SHORT.exec(path);
  if (live && (path.startsWith('/live/') || ACCOUNTS.some((a) => a.username === live[1]))) {
    const account = authorize(res, meta, live[1] as string, live[2] as string);
    if (account) {
      const id = Number(live[3]);
      await serveLive(
        req,
        res,
        ctx,
        meta,
        account,
        id,
        path.startsWith('/live/') && live[4] === 'm3u8',
      );
    }
    return true;
  }

  const segment = HLS_SEGMENT.exec(path);
  if (segment) {
    const recipe = ALL_RECIPES.find((r) => r === segment[1]);
    if (!recipe) {
      sendText(res, 404, 'text/plain', 'not found');
      return true;
    }
    await serveHlsSegment(res, ctx, meta, recipe, Number(segment[2]));
    return true;
  }

  const relative = RELATIVE.exec(path);
  if (relative) {
    const compat = ACCOUNTS.find((a) => a.profile === 'compat');
    if (!compat) return false;
    meta.account = compat.username;
    await serveLive(req, res, ctx, meta, compat, Number(relative[1]), false);
    return true;
  }

  const timeshift = TIMESHIFT.exec(path);
  const php = path === '/streaming/timeshift.php';
  const catchup = CATCHUP.exec(path);
  if (timeshift || php) {
    const user = timeshift?.[1] ?? url.searchParams.get('username');
    const pass = timeshift?.[2] ?? url.searchParams.get('password');
    const id = Number(timeshift?.[3] ?? url.searchParams.get('stream'));
    meta.streamId = Number.isInteger(id) ? id : null;
    const account = authorize(res, meta, user ?? '', pass ?? '');
    if (account) await serveRecorded(req, res, ctx, meta, account);
    return true;
  }
  if (catchup || FLUSSONIC.test(path)) {
    const id = catchup?.[1] ?? LEADING_ID.exec(path)?.[1];
    meta.streamId = id === undefined ? null : Number(id);
    await serveRecorded(req, res, ctx, meta, null);
    return true;
  }
  return false;
};
