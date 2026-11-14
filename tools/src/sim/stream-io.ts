import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Account, findAccount } from './accounts.ts';
import type { RequestMeta, SimContext } from './context.ts';
import { applyStreamFaults, type Fault, parseFaults } from './faults.ts';
import { ensureRecipe, type RecipeFiles } from './media.ts';
import type { RecipeName } from './recipes.ts';
import { requestFaults } from './request-faults.ts';
import { sendText } from './routes-data.ts';

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

/** Checks credentials: unknown answers 401, expired 403; null when it answered. */
export function authorize(
  res: ServerResponse,
  meta: RequestMeta,
  user: string,
  pass: string,
): Account | null {
  const account = findAccount(user, pass);
  if (!account) {
    sendText(res, 401, 'text/plain');
    return null;
  }
  meta.account = account.username;
  if (account.status === 'Expired') {
    sendText(res, 403, 'text/plain');
    return null;
  }
  return account;
}

/**
 * Takes a connection slot for the life of the response. Beyond the account limit it answers per
 * the account policy and returns false. The slot is released when the response finishes or closes.
 */
export function takeSlot(res: ServerResponse, ctx: SimContext, account: Account): boolean {
  if (ctx.connections.open(account.username) > account.maxConnections) {
    ctx.connections.close(account.username);
    if (account.limitPolicy === 'status-509') sendText(res, 509, 'text/plain');
    else if (account.limitPolicy === 'status-403') sendText(res, 403, 'text/plain');
    else sendText(res, 200, 'text/plain', 'Max connections reached');
    return false;
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    ctx.connections.close(account.username);
  };
  res.once('finish', release);
  res.once('close', release);
  return true;
}

/**
 * Resolves the faults of a media request. A `?fault=` query was already applied by the server;
 * otherwise, with `useRules`, the newest matching runtime rule applies (and is consumed), then the
 * catalog fault. Returns the stream-level faults, or null when a request-level fault answered.
 */
export async function resolveFaults(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SimContext,
  meta: RequestMeta,
  catalogFault: string | null,
  useRules: boolean,
): Promise<Fault[] | null> {
  const query = new URL(req.url ?? '/', 'http://sim').searchParams.get('fault');
  let spec = query ?? catalogFault;
  if (query === null && useRules && meta.account !== null && meta.streamId !== null) {
    const rule = ctx.faultRules.take(meta.account, meta.streamId);
    if (rule) {
      spec = rule.spec;
      meta.faultRule = rule.id;
    }
  }
  if (spec === null) return [];
  const faults = parseFaults(spec);
  if (query === null) {
    meta.fault = spec;
    if (await requestFaults(req, res, faults)) return null;
  }
  return faults.filter(
    (f) => f.kind === 'drop' || f.kind === 'stall' || f.kind === 'rate' || f.kind === 'type',
  );
}

/** Generated recipe files; answers 503 and returns null without FFmpeg or when generation fails. */
export async function loadRecipe(
  res: ServerResponse,
  ctx: SimContext,
  recipe: RecipeName,
): Promise<RecipeFiles | null> {
  const media = ctx.media;
  if (media === null || media.ffmpeg === null) {
    sendText(res, 503, 'text/plain', 'FFmpeg not found: set FFMPEG_PATH or install FFmpeg');
    return null;
  }
  try {
    const files = await ensureRecipe(recipe, {
      ffmpeg: media.ffmpeg,
      cacheDir: media.cacheDir,
      seconds: media.seconds,
    });
    return res.destroyed ? null : files;
  } catch (error) {
    sendText(res, 503, 'text/plain', `FFmpeg failed: ${(error as Error).message}`);
    return null;
  }
}

/** Pipes a source to the response through the stream faults; errors end the response abruptly. */
export async function pipeFaulted(
  res: ServerResponse,
  source: Readable,
  faults: readonly Fault[],
): Promise<void> {
  await pipeline(applyStreamFaults(source, faults), res).catch(() => undefined);
}

/** Serves a file with `Range` support, a connection slot for `account` and stream faults. */
export async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SimContext,
  opts: { file: string; type: string; account: Account | null; faults: readonly Fault[] },
): Promise<void> {
  const size = statSync(opts.file).size;
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${size}`, 'content-length': 0 });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const head = req.method === 'HEAD';
  if (!head && opts.account && !takeSlot(res, ctx, opts.account)) return;
  const headers: Record<string, string | number> = {
    'content-type': opts.type,
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (head) {
    res.end();
    return;
  }
  await pipeFaulted(res, createReadStream(opts.file, { start, end }), opts.faults);
}
