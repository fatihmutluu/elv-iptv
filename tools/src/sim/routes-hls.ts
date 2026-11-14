import { createReadStream, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { RouteHandler, SimContext } from './context.ts';
import { hlsPlaylist, segmentUri, vodPlaylist } from './hls.ts';
import type { RecipeFiles } from './media.ts';
import { firstVideoPts } from './mpegts.ts';
import { ALL_RECIPES, RECIPES, type RecipeName, type SubtitleLang } from './recipes.ts';
import { sendText } from './routes-data.ts';
import { loadRecipe, pipeFaulted } from './stream-io.ts';
import { vttSegment } from './subtitles.ts';

const VIDEO = /^\/hls\/(?<recipe>[^/]+)\/(?:(?<mode>live|vod)\.m3u8|(?<seq>\d+)\.ts)$/;
const SUBS =
  /^\/hls\/(?<recipe>[^/]+)\/subs\/(?<lang>[^/]+)\/(?:(?<mode>live|vod)\.m3u8|(?<seq>\d+)\.vtt)$/;
const PTS_BYTES = 65_536;
const ptsMemo = new Map<string, number>();

function segmentFile(files: RecipeFiles, seq: number): string {
  const index = String(seq % files.segmentCount).padStart(5, '0');
  return join(files.segmentsDir, `seg${index}.ts`);
}

/** First video PTS of a segment file, read from its first 64 KiB once per path. */
async function segmentPts(file: string): Promise<number> {
  const known = ptsMemo.get(file);
  if (known !== undefined) return known;
  const handle = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(PTS_BYTES), 0, PTS_BYTES, 0);
    const pts = firstVideoPts(buffer.subarray(0, bytesRead));
    if (pts === null) throw new Error(`no video PTS in ${file}`);
    ptsMemo.set(file, pts);
    return pts;
  } finally {
    await handle.close();
  }
}

async function serveSegment(res: ServerResponse, files: RecipeFiles, seq: number): Promise<void> {
  const file = segmentFile(files, seq);
  res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': statSync(file).size });
  await pipeFaulted(res, createReadStream(file), []);
}

async function serveCues(
  res: ServerResponse,
  ctx: SimContext,
  files: RecipeFiles,
  lang: SubtitleLang,
  seq: number,
): Promise<void> {
  const pts = await segmentPts(segmentFile(files, seq));
  const seconds = ctx.media?.seconds ?? 0;
  sendText(res, 200, 'text/vtt', vttSegment(lang, seq % files.segmentCount, seconds, pts));
}

/**
 * Account-free HLS: TS segments, the live window and VOD media playlists of a recipe, and for subtitle
 * recipes the WebVTT playlists and segments of each language. Unknown recipes and languages answer 404.
 */
export const hlsRoute: RouteHandler = async (req, res, ctx, meta) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = new URL(req.url ?? '/', 'http://sim').pathname;
  const groups = (VIDEO.exec(path) ?? SUBS.exec(path))?.groups;
  if (!groups) return false;
  const recipe: RecipeName | undefined = ALL_RECIPES.find((r) => r === groups.recipe);
  const langs = recipe === undefined ? [] : (RECIPES[recipe].subtitles?.langs ?? []);
  const lang = groups.lang === undefined ? null : langs.find((l) => l === groups.lang);
  if (recipe === undefined || lang === undefined) {
    sendText(res, 404, 'text/plain', 'not found');
    return true;
  }
  const seq = groups.seq === undefined ? 0 : Number(groups.seq);
  if (!Number.isSafeInteger(seq)) {
    sendText(res, 404, 'text/plain', 'not found');
    return true;
  }
  meta.recipe = recipe;
  const files = await loadRecipe(res, ctx, recipe);
  if (files === null) return true;
  const uri = segmentUri(recipe, lang);
  if (groups.mode === 'live') {
    const body = hlsPlaylist(recipe, files.segmentCount, ctx.now().getTime(), uri);
    sendText(res, 200, 'application/vnd.apple.mpegurl', body);
  } else if (groups.mode === 'vod') {
    sendText(res, 200, 'application/vnd.apple.mpegurl', vodPlaylist(files.durations, uri));
  } else if (lang === null) {
    await serveSegment(res, files, seq);
  } else {
    await serveCues(res, ctx, files, lang, seq);
  }
  return true;
};
