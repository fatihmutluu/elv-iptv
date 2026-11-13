import { buildCatalog, type RecipeName } from './catalog.ts';
import type { RouteHandler } from './context.ts';
import { sendText } from './routes-data.ts';
import { authorize, loadRecipe, resolveFaults, sendFile } from './stream-io.ts';

const VOD_PATH = /^\/(movie|series)\/([^/]+)\/([^/]+)\/(\d+)\.(mp4|mkv)$/;
const TYPES = { mp4: 'video/mp4', mkv: 'video/x-matroska' } as const;

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
  const match = VOD_PATH.exec(new URL(req.url ?? '/', 'http://sim').pathname);
  if (!match) return false;
  const [, kind, user, pass, idText, ext] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    'mp4' | 'mkv',
  ];
  const account = authorize(res, meta, user, pass);
  if (!account) return true;
  const recipe = findRecipe(kind, account.profile, ctx.seed, Number(idText));
  if (recipe === null) {
    sendText(res, 404, 'text/plain', 'not found');
    return true;
  }
  meta.recipe = recipe;
  const faults = await resolveFaults(req, res, meta, null);
  if (faults === null) return true;
  const files = await loadRecipe(res, ctx, recipe);
  if (files === null) return true;
  const file = ext === 'mp4' ? files.vodMp4 : files.vodMkv;
  await sendFile(req, res, ctx, { file, type: TYPES[ext], account, faults });
  return true;
};
