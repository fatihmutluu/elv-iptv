import { type ItemRow, MAX_VOD_COLLECTION_NAME_LENGTH, type VodCollectionRecord } from '@elv/data';

/** Hydrated custom VOD collection pairing collection metadata with parental-filtered items (`#403`). */
export interface HydratedVodCollection {
  readonly collection: VodCollectionRecord;
  readonly items: readonly ItemRow[];
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Validates and trims a draft collection name; returns `null` if blank, too long, or invalid. */
export function validateCollectionNameDraft(raw: string): string | null {
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_VOD_COLLECTION_NAME_LENGTH ||
    hasControlChar(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

/** Keeps previously rendered collections on failed refresh (`null`) for zero-blink Home updates. */
export function mergeHydratedCollections(
  fetched: readonly HydratedVodCollection[] | null,
  previous: readonly HydratedVodCollection[],
): readonly HydratedVodCollection[] {
  return fetched === null ? previous : fetched;
}
