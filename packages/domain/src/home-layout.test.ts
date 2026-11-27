import { describe, expect, it } from 'vitest';
import {
  createMemoryPreferencesStore,
  DEFAULT_HOME_LAYOUT,
  DEFAULT_PREFERENCES,
  HOME_LAYOUT_SECTION_IDS,
  homeLayoutEquals,
  isHomeLayoutSectionId,
  MAX_PREFERENCES_BYTES,
  normalizeHomeLayout,
  parsePreferences,
  serializePreferences,
} from './index';

describe('homeLayout preference (Wave P4)', () => {
  it('defines canonical DEFAULT_HOME_LAYOUT with all 7 sections visible', () => {
    expect(HOME_LAYOUT_SECTION_IDS).toEqual([
      'continue',
      'newEpisodes',
      'live',
      'movies',
      'series',
      'mylist',
      'collections',
    ]);
    expect(DEFAULT_HOME_LAYOUT).toEqual([
      { id: 'continue', visible: true },
      { id: 'newEpisodes', visible: true },
      { id: 'live', visible: true },
      { id: 'movies', visible: true },
      { id: 'series', visible: true },
      { id: 'mylist', visible: true },
      { id: 'collections', visible: true },
    ]);
    expect(DEFAULT_PREFERENCES.homeLayout).toEqual(DEFAULT_HOME_LAYOUT);
    expect(Object.isFrozen(DEFAULT_HOME_LAYOUT)).toBe(true);
  });

  it('validates section ids with isHomeLayoutSectionId', () => {
    for (const id of HOME_LAYOUT_SECTION_IDS) {
      expect(isHomeLayoutSectionId(id)).toBe(true);
    }
    expect(isHomeLayoutSectionId('unknown')).toBe(false);
    expect(isHomeLayoutSectionId(123)).toBe(false);
    expect(isHomeLayoutSectionId(null)).toBe(false);
  });

  it('normalizes invalid/non-array inputs to DEFAULT_HOME_LAYOUT', () => {
    expect(normalizeHomeLayout(undefined)).toBe(DEFAULT_HOME_LAYOUT);
    expect(normalizeHomeLayout(null)).toBe(DEFAULT_HOME_LAYOUT);
    expect(normalizeHomeLayout('live')).toBe(DEFAULT_HOME_LAYOUT);
    expect(normalizeHomeLayout({})).toBe(DEFAULT_HOME_LAYOUT);
    expect(normalizeHomeLayout([])).toBe(DEFAULT_HOME_LAYOUT);
  });

  it('deduplicates, drops invalid ids, defaults non-boolean visible to true, and appends missing sections', () => {
    const normalized = normalizeHomeLayout([
      { id: 'live', visible: true },
      { id: 'movies', visible: false },
      { id: 'live', visible: false },
      { id: 'bogus', visible: true },
      'not-an-object',
      { id: 'continue', visible: 'yes' },
    ]);

    expect(normalized).toEqual([
      { id: 'live', visible: true },
      { id: 'movies', visible: false },
      { id: 'continue', visible: true },
      { id: 'newEpisodes', visible: true },
      { id: 'series', visible: true },
      { id: 'mylist', visible: true },
      { id: 'collections', visible: true },
    ]);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it('preserves saved pre-#502 layouts and appends newEpisodes as visible', () => {
    const legacy = [
      { id: 'continue', visible: true },
      { id: 'live', visible: false },
      { id: 'mylist', visible: true },
      { id: 'movies', visible: true },
      { id: 'series', visible: true },
      { id: 'collections', visible: false },
    ];
    expect(normalizeHomeLayout(legacy)).toEqual([...legacy, { id: 'newEpisodes', visible: true }]);
  });

  it('returns canonical DEFAULT_HOME_LAYOUT reference when normalized matches default', () => {
    const normalized = normalizeHomeLayout(DEFAULT_HOME_LAYOUT.map((s) => ({ ...s })));
    expect(normalized).toBe(DEFAULT_HOME_LAYOUT);
    expect(homeLayoutEquals(normalized, DEFAULT_HOME_LAYOUT)).toBe(true);
    expect(
      homeLayoutEquals(normalized, [
        { id: 'live', visible: true },
        { id: 'continue', visible: true },
        { id: 'mylist', visible: true },
        { id: 'movies', visible: true },
        { id: 'series', visible: true },
        { id: 'collections', visible: true },
      ]),
    ).toBe(false);
  });

  it('round-trips custom homeLayout through parsePreferences and serializePreferences', () => {
    const customLayout = [
      { id: 'live', visible: true },
      { id: 'continue', visible: true },
      { id: 'newEpisodes', visible: true },
      { id: 'mylist', visible: false },
      { id: 'series', visible: true },
      { id: 'movies', visible: true },
      { id: 'collections', visible: false },
    ] as const;

    const encodedDefault = serializePreferences(DEFAULT_PREFERENCES);
    expect(encodedDefault.ok).toBe(true);
    if (!encodedDefault.ok) return;
    expect(new TextEncoder().encode(encodedDefault.value).byteLength).toBeLessThan(
      MAX_PREFERENCES_BYTES,
    );

    const encodedCustom = serializePreferences({
      ...DEFAULT_PREFERENCES,
      homeLayout: customLayout,
    });
    expect(encodedCustom.ok).toBe(true);
    if (!encodedCustom.ok) return;
    expect(new TextEncoder().encode(encodedCustom.value).byteLength).toBeLessThan(
      MAX_PREFERENCES_BYTES,
    );

    const parsed = parsePreferences(encodedCustom.value);
    expect(parsed.homeLayout).toEqual(customLayout);
  });

  it('updates homeLayout cleanly through PreferencesStore.update()', async () => {
    const store = createMemoryPreferencesStore();
    const res = await store.update({
      homeLayout: [
        { id: 'movies', visible: true },
        { id: 'live', visible: false },
      ],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.homeLayout).toEqual([
      { id: 'movies', visible: true },
      { id: 'live', visible: false },
      { id: 'continue', visible: true },
      { id: 'newEpisodes', visible: true },
      { id: 'series', visible: true },
      { id: 'mylist', visible: true },
      { id: 'collections', visible: true },
    ]);
  });
});
