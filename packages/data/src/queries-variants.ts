import type { SqlDriver } from '@elv/domain';
import { parseLiveVariant } from './live-variants';
import { parseCategoryId, sourceOfKey } from './queries';
import { parseVodVersion } from './vod-versions';

/** One selectable quality variant of a live channel (`#218`). */
export interface LiveVariantOption {
  readonly key: string;
  readonly title: string;
  readonly qualityLabel: string;
  readonly qualityRank: number;
}

/** One selectable version of a multi-version VOD movie (`#404`). */
export interface VodVersionOption {
  readonly key: string;
  readonly title: string;
  readonly versionLabel: string;
  readonly year: number | null;
  readonly qualityRank: number;
}

/**
 * Lists all visible quality variants of a live channel sharing its `variant_base_fold` (`#218`).
 * When `categoryId` is provided (either encoded `sourceId|live|providerId` or raw category provider id),
 * restricts matches strictly to `(source_id, category_id)`. Ordered highest `quality_rank` first.
 */
export async function queryLiveVariants(
  db: SqlDriver,
  itemKey: string,
  categoryId?: string,
): Promise<LiveVariantOption[]> {
  const sourceId = sourceOfKey(itemKey);
  if (sourceId === undefined) return [];
  const seed = (
    await db.all<{ variant_base_fold: string }>(
      'SELECT variant_base_fold FROM live WHERE source_id = ? AND key = ? AND is_hidden = 0 LIMIT 1',
      [sourceId, itemKey],
    )
  )[0];
  if (seed === undefined || seed.variant_base_fold === '') return [];

  let providerCategoryId: string | undefined;
  if (categoryId !== undefined && categoryId !== '') {
    const parsed = parseCategoryId(categoryId);
    providerCategoryId = parsed !== undefined ? parsed.providerId : categoryId;
  }

  const rows =
    providerCategoryId !== undefined
      ? await db.all<{ key: string; name: string; quality_rank: number }>(
          `SELECT l.key, l.name, l.quality_rank
             FROM live l
             JOIN placements p
               ON p.source_id = l.source_id AND p.kind = 'live' AND p.item_key = l.key
            WHERE l.source_id = ? AND l.is_hidden = 0 AND l.variant_base_fold = ?
              AND p.category_id = ? AND p.is_hidden = 0
              AND EXISTS (SELECT 1 FROM sources s WHERE s.id = l.source_id AND s.deleting = 0)
            ORDER BY l.quality_rank DESC, p.position ASC, l.id ASC`,
          [sourceId, seed.variant_base_fold, providerCategoryId],
        )
      : await db.all<{ key: string; name: string; quality_rank: number }>(
          `SELECT l.key, l.name, l.quality_rank
             FROM live l
            WHERE l.source_id = ? AND l.is_hidden = 0 AND l.variant_base_fold = ?
              AND EXISTS (SELECT 1 FROM sources s WHERE s.id = l.source_id AND s.deleting = 0)
            ORDER BY l.quality_rank DESC, l.id ASC`,
          [sourceId, seed.variant_base_fold],
        );

  return rows.map((r) => {
    const parsed = parseLiveVariant(r.name);
    return {
      key: r.key,
      title: r.name,
      qualityLabel: parsed.qualityLabel,
      qualityRank: r.quality_rank,
    };
  });
}

/**
 * Lists all visible versions of a VOD movie sharing its `version_group_key` within the same source (`#404`),
 * ordered highest `qualityRank` first.
 */
export async function queryItemVersions(
  db: SqlDriver,
  itemKey: string,
): Promise<VodVersionOption[]> {
  const sourceId = sourceOfKey(itemKey);
  if (sourceId === undefined) return [];
  const seed = (
    await db.all<{ version_group_key: string }>(
      'SELECT version_group_key FROM movies WHERE source_id = ? AND key = ? AND is_hidden = 0 LIMIT 1',
      [sourceId, itemKey],
    )
  )[0];
  if (seed === undefined || seed.version_group_key === '') return [];

  const rows = await db.all<{
    id: number;
    key: string;
    name: string;
    year: number | null;
    version_label: string | null;
  }>(
    `SELECT id, key, name, year, version_label
       FROM movies
      WHERE source_id = ? AND is_hidden = 0 AND version_group_key = ?
        AND EXISTS (SELECT 1 FROM sources s WHERE s.id = movies.source_id AND s.deleting = 0)
      ORDER BY id ASC`,
    [sourceId, seed.version_group_key],
  );

  return rows
    .map((r) => {
      const parsed = parseVodVersion(r.name, r.year);
      return {
        id: r.id,
        key: r.key,
        title: r.name,
        versionLabel: r.version_label ?? parsed.versionLabel,
        year: r.year,
        qualityRank: parsed.qualityRank,
      };
    })
    .sort((a, b) => b.qualityRank - a.qualityRank || a.id - b.id)
    .map(({ key, title, versionLabel, year, qualityRank }) => ({
      key,
      title,
      versionLabel,
      year,
      qualityRank,
    }));
}
