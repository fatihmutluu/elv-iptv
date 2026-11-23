import type { CatalogService, LiveVariantOption } from '@elv/data';
import { useCallback, useEffect, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';

/** Parameters of {@link useLiveQualityVariants}. */
export interface UseLiveQualityVariantsParams {
  readonly catalog: Partial<Pick<CatalogService, 'liveVariants'>>;
  readonly activeTarget: PlayTarget;
  readonly onSelect: (itemKey: string, title?: string) => void;
}

/**
 * Loads selectable quality variants (`4K` / `FHD` / `HD` / `SD`) for the active live channel (`#218`).
 * Returns an empty list for VOD playback or channels without sibling variants.
 */
export function useLiveQualityVariants({
  catalog,
  activeTarget,
  onSelect,
}: UseLiveQualityVariantsParams) {
  const [variants, setVariants] = useState<readonly LiveVariantOption[]>([]);
  const isLive = activeTarget.kind === 'live';
  const itemKey = activeTarget.itemKey;
  const categoryId = activeTarget.categoryId;

  useEffect(() => {
    if (!isLive || catalog.liveVariants === undefined) {
      setVariants([]);
      return undefined;
    }
    let alive = true;
    void catalog
      .liveVariants(itemKey, categoryId)
      .then((rows) => {
        if (alive) setVariants(rows.length > 1 ? rows : []);
      })
      .catch(() => {
        if (alive) setVariants([]);
      });
    return () => {
      alive = false;
    };
  }, [catalog, categoryId, isLive, itemKey]);

  const selectVariant = useCallback(
    (key: string) => {
      const chosen = variants.find((v) => v.key === key);
      onSelect(key, chosen?.title);
    },
    [onSelect, variants],
  );

  const sheetProps =
    variants.length > 1
      ? {
          qualityVariants: variants,
          activeQualityKey: itemKey,
          onSelectQualityVariant: selectVariant,
        }
      : {};

  return { variants, selectVariant, sheetProps };
}
