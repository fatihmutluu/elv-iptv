import { createReadStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { findAccount } from './accounts.ts';
import { buildCatalog, type RecipeName } from './catalog.ts';
import type { RouteHandler } from './context.ts';
import { ensureRecipe } from './media.ts';
import { sendText } from './routes-data.ts';

const VOD_PATH = /^\/(movie|series)\/([^/]+)\/([^/]+)\/(\d+)\.(mp4|mkv)$/;
const TYPES = { mp4: 'video/mp4', mkv: 'video/x-matroska' } as const;

type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/** Parses a single `bytes=` range against a file size; null means serve the whole file. */
function parseRange(header: string | undefined, size: number): ByteRange {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const last = Number(match[2]);
    if (last === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  const start = Number(match[1]);
  if (start >= size) return 'unsatisfiable';
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return end < start ? null : { start, end };
}

function findRecipe(
  kind: string,
  profile: Parameters<typeof buildCatalog>[0],
  seed: number,
  id: number,
): RecipeName | null {
  const catalog = buildCatalog(profile, seed);
  if (kind === 'movie') return catalog.movies.find((m) => m.id === id)?.recipe ?? null;
  for (const s of catalog.series) {
    const found = s.episodes.find((e) => e.id === id);
    if (found) return found.recipe;
  }
  return null;
}

/** On-demand movies and episodes: generated media with `Range` support. */
export const mediaRoute: RouteHandler = async (req, res, ctx, meta) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const url = new URL(req.url ?? '/', 'http://sim');
  const match = VOD_PATH.exec(url.pathname);
  if (!match) return false;
  const [, kind, user, pass, idText, ext] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    'mp4' | 'mkv',
  ];
  const account = findAccount(user, pass);
  if (!account) {
    sendText(res, 401, 'text/plain');
    return true;
  }
  meta.account = account.username;
  if (account.status === 'Expired') {
    sendText(res, 403, 'text/plain');
    return true;
  }
  const recipe = findRecipe(kind, account.profile, ctx.seed, Number(idText));
  if (recipe === null) {
    sendText(res, 404, 'text/plain', 'not found');
    return true;
  }
  meta.recipe = recipe;
  const media = ctx.media;
  if (media === null || media.ffmpeg === null) {
    sendText(res, 503, 'text/plain', 'FFmpeg not found: set FFMPEG_PATH or install FFmpeg');
    return true;
  }
  let file: string;
  try {
    const files = await ensureRecipe(recipe, {
      ffmpeg: media.ffmpeg,
      cacheDir: media.cacheDir,
      seconds: media.seconds,
    });
    file = ext === 'mp4' ? files.vodMp4 : files.vodMkv;
  } catch (error) {
    sendText(res, 503, 'text/plain', `FFmpeg failed: ${(error as Error).message}`);
    return true;
  }
  const size = statSync(file).size;
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${size}`, 'content-length': 0 });
    res.end();
    return true;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const headers: Record<string, string | number> = {
    'content-type': TYPES[ext],
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await pipeline(createReadStream(file, { start, end }), res).catch(() => undefined);
  return true;
};
