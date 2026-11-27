/** Canonical Home screen section identifiers in default order (Wave P8, `#508`). */
export const HOME_LAYOUT_SECTION_IDS = [
  'continue',
  'newEpisodes',
  'live',
  'movies',
  'series',
  'mylist',
  'collections',
] as const;

/** Identifier for a customizable Home screen rail section (Wave P4). */
export type HomeLayoutSectionId = (typeof HOME_LAYOUT_SECTION_IDS)[number];

/** Visibility and order entry for one Home screen rail section (Wave P4). */
export interface HomeLayoutSectionPref {
  readonly id: HomeLayoutSectionId;
  readonly visible: boolean;
}

/** Default Home screen layout with all 7 canonical sections visible in canonical order. */
export const DEFAULT_HOME_LAYOUT: readonly HomeLayoutSectionPref[] = Object.freeze(
  HOME_LAYOUT_SECTION_IDS.map((id) => Object.freeze({ id, visible: true })),
);

const HOME_LAYOUT_ID_SET: ReadonlySet<string> = new Set(HOME_LAYOUT_SECTION_IDS);

/** Returns true when `value` is a supported {@link HomeLayoutSectionId}. */
export function isHomeLayoutSectionId(value: unknown): value is HomeLayoutSectionId {
  return typeof value === 'string' && HOME_LAYOUT_ID_SET.has(value);
}

/** Returns true when two {@link HomeLayoutSectionPref} lists have identical order and visibility. */
export function homeLayoutEquals(
  a: readonly HomeLayoutSectionPref[],
  b: readonly HomeLayoutSectionPref[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const itemA = a[i];
    const itemB = b[i];
    if (itemA === undefined || itemB === undefined) return false;
    if (itemA.id !== itemB.id || itemA.visible !== itemB.visible) return false;
  }
  return true;
}

/**
 * Normalizes an untrusted Home layout array: deduplicates entries, drops invalid ids,
 * defaults non-boolean `visible` flags to `true`, and appends any missing canonical sections
 * as visible so upgrades never lose sections.
 */
export function normalizeHomeLayout(raw: unknown): readonly HomeLayoutSectionPref[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_HOME_LAYOUT;
  const out: HomeLayoutSectionPref[] = [];
  const seen = new Set<HomeLayoutSectionId>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    if (!isHomeLayoutSectionId(rec.id) || seen.has(rec.id)) continue;
    seen.add(rec.id);
    out.push(
      Object.freeze({
        id: rec.id,
        visible: typeof rec.visible === 'boolean' ? rec.visible : true,
      }),
    );
  }
  if (out.length === 0) return DEFAULT_HOME_LAYOUT;
  for (const id of HOME_LAYOUT_SECTION_IDS) {
    if (!seen.has(id)) {
      out.push(Object.freeze({ id, visible: true }));
    }
  }
  return homeLayoutEquals(out, DEFAULT_HOME_LAYOUT) ? DEFAULT_HOME_LAYOUT : Object.freeze(out);
}
