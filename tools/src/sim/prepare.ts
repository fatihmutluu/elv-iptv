import { ensureRecipe, missingEncoders } from './media.ts';
import { ALL_RECIPES } from './recipes.ts';
import { defaultCacheDir } from './server.ts';

/** Result of pre-generating every encodable simulator recipe. */
export interface PrepareResult {
  prepared: number;
  skipped: string[];
  cacheDir: string;
}

/** Ensures every encodable simulator recipe exists in `cacheDir` before a gate or manual session starts. */
export async function prepareAllRecipes(
  ffmpeg: string,
  opts: { cacheDir?: string; seconds?: number } = {},
): Promise<PrepareResult> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const seconds = opts.seconds ?? 600;
  let prepared = 0;
  const skipped: string[] = [];
  for (const recipe of ALL_RECIPES) {
    const missing = missingEncoders(ffmpeg, recipe);
    if (missing.length > 0) {
      skipped.push(`skipped ${recipe} (no ${missing.join(' ')})`);
      continue;
    }
    await ensureRecipe(recipe, { ffmpeg, cacheDir, seconds });
    prepared += 1;
  }
  return { prepared, skipped, cacheDir };
}
