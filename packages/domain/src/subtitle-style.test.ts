import { describe, expect, it } from 'vitest';
import {
  createKvPreferencesStore,
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  DEFAULT_SUBTITLE_STYLE,
  isSubtitleBgColor,
  isSubtitleEdgeStyle,
  isSubtitleFontSize,
  isSubtitleTextColor,
  isSubtitleVerticalPosition,
  MAX_PREFERENCES_BYTES,
  normalizeSubtitleStyle,
  type PreferencesKvBackend,
  parsePreferences,
  SUBTITLE_BG_COLORS,
  SUBTITLE_EDGE_STYLES,
  SUBTITLE_FONT_SIZES,
  SUBTITLE_TEXT_COLORS,
  SUBTITLE_VERTICAL_POSITIONS,
  type SubtitleStyleConfig,
  serializePreferences,
  subtitleStyleEquals,
} from './index';

describe('SubtitleStyleConfig & preferences persistence (#32)', () => {
  it('exposes defaults and validates all subtitle style enum guards', () => {
    expect(DEFAULT_SUBTITLE_STYLE).toEqual({
      fontSize: 'medium',
      textColor: 'white',
      backgroundColor: 'translucent',
      edgeStyle: 'outline',
      verticalPosition: 'bottom',
    });
    expect(DEFAULT_PREFERENCES.subtitleStyle).toBe(DEFAULT_SUBTITLE_STYLE);

    for (const v of SUBTITLE_FONT_SIZES) expect(isSubtitleFontSize(v)).toBe(true);
    for (const v of SUBTITLE_TEXT_COLORS) expect(isSubtitleTextColor(v)).toBe(true);
    for (const v of SUBTITLE_BG_COLORS) expect(isSubtitleBgColor(v)).toBe(true);
    for (const v of SUBTITLE_EDGE_STYLES) expect(isSubtitleEdgeStyle(v)).toBe(true);
    for (const v of SUBTITLE_VERTICAL_POSITIONS) expect(isSubtitleVerticalPosition(v)).toBe(true);

    for (const bad of ['', 'huge', 'red', 123, null, undefined, {}, []]) {
      expect(isSubtitleFontSize(bad)).toBe(false);
      expect(isSubtitleTextColor(bad)).toBe(false);
      expect(isSubtitleBgColor(bad)).toBe(false);
      expect(isSubtitleEdgeStyle(bad)).toBe(false);
      expect(isSubtitleVerticalPosition(bad)).toBe(false);
    }
  });

  it('normalizes valid, partial, and corrupt subtitle style inputs', () => {
    expect(normalizeSubtitleStyle(undefined)).toBe(DEFAULT_SUBTITLE_STYLE);
    expect(normalizeSubtitleStyle(null)).toBe(DEFAULT_SUBTITLE_STYLE);
    expect(normalizeSubtitleStyle('invalid')).toBe(DEFAULT_SUBTITLE_STYLE);
    expect(normalizeSubtitleStyle([])).toBe(DEFAULT_SUBTITLE_STYLE);
    expect(normalizeSubtitleStyle({})).toBe(DEFAULT_SUBTITLE_STYLE);
    expect(normalizeSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE })).toBe(DEFAULT_SUBTITLE_STYLE);

    const partial = normalizeSubtitleStyle({ fontSize: 'large', textColor: 'yellow' });
    expect(partial).toEqual({
      fontSize: 'large',
      textColor: 'yellow',
      backgroundColor: 'translucent',
      edgeStyle: 'outline',
      verticalPosition: 'bottom',
    });
    expect(Object.isFrozen(partial)).toBe(true);

    const corrupt = normalizeSubtitleStyle({
      fontSize: 'giant',
      textColor: 42,
      backgroundColor: 'opaque',
      edgeStyle: 'glow',
      verticalPosition: 'top',
    });
    expect(corrupt).toEqual({
      fontSize: 'medium',
      textColor: 'white',
      backgroundColor: 'opaque',
      edgeStyle: 'outline',
      verticalPosition: 'top',
    });
  });

  it('compares subtitle styles with subtitleStyleEquals', () => {
    expect(subtitleStyleEquals(DEFAULT_SUBTITLE_STYLE, { ...DEFAULT_SUBTITLE_STYLE })).toBe(true);
    expect(
      subtitleStyleEquals(DEFAULT_SUBTITLE_STYLE, {
        ...DEFAULT_SUBTITLE_STYLE,
        fontSize: 'extraLarge',
      }),
    ).toBe(false);
    expect(
      subtitleStyleEquals(DEFAULT_SUBTITLE_STYLE, {
        ...DEFAULT_SUBTITLE_STYLE,
        textColor: 'cyan',
      }),
    ).toBe(false);
    expect(
      subtitleStyleEquals(DEFAULT_SUBTITLE_STYLE, {
        ...DEFAULT_SUBTITLE_STYLE,
        backgroundColor: 'none',
      }),
    ).toBe(false);
    expect(
      subtitleStyleEquals(DEFAULT_SUBTITLE_STYLE, {
        ...DEFAULT_SUBTITLE_STYLE,
        edgeStyle: 'dropShadow',
      }),
    ).toBe(false);
    expect(
      subtitleStyleEquals(DEFAULT_SUBTITLE_STYLE, {
        ...DEFAULT_SUBTITLE_STYLE,
        verticalPosition: 'raised',
      }),
    ).toBe(false);
  });

  it('omits subtitleStyle from serialized JSON when equal to defaults and stays under MAX_PREFERENCES_BYTES', () => {
    const defaultEncoded = serializePreferences(DEFAULT_PREFERENCES);
    expect(defaultEncoded.ok).toBe(true);
    if (defaultEncoded.ok) {
      const parsedJson = JSON.parse(defaultEncoded.value) as Record<string, unknown>;
      expect('subtitleStyle' in parsedJson).toBe(false);
      expect(new TextEncoder().encode(defaultEncoded.value).byteLength).toBeLessThan(
        MAX_PREFERENCES_BYTES,
      );
      expect(parsePreferences(defaultEncoded.value).subtitleStyle).toBe(DEFAULT_SUBTITLE_STYLE);
    }

    const custom: SubtitleStyleConfig = {
      fontSize: 'extraLarge',
      textColor: 'yellow',
      backgroundColor: 'opaque',
      edgeStyle: 'dropShadow',
      verticalPosition: 'raised',
    };
    const customEncoded = serializePreferences({
      ...DEFAULT_PREFERENCES,
      subtitleStyle: custom,
    });
    expect(customEncoded.ok).toBe(true);
    if (customEncoded.ok) {
      const parsedJson = JSON.parse(customEncoded.value) as Record<string, unknown>;
      expect(parsedJson.subtitleStyle).toEqual(custom);
      expect(new TextEncoder().encode(customEncoded.value).byteLength).toBeLessThan(
        MAX_PREFERENCES_BYTES,
      );
      expect(parsePreferences(customEncoded.value).subtitleStyle).toEqual(custom);
    }
  });

  it('falls back cleanly when persisted subtitleStyle is missing or corrupt', () => {
    const legacy = parsePreferences(JSON.stringify({ version: 1, locale: 'tr' }));
    expect(legacy.subtitleStyle).toBe(DEFAULT_SUBTITLE_STYLE);

    const corrupt = parsePreferences(
      JSON.stringify({
        version: 1,
        subtitleStyle: { fontSize: 'bogus', textColor: 'green', edgeStyle: 99 },
      }),
    );
    expect(corrupt.subtitleStyle).toEqual({
      fontSize: 'medium',
      textColor: 'green',
      backgroundColor: 'translucent',
      edgeStyle: 'outline',
      verticalPosition: 'bottom',
    });

    const nonObject = parsePreferences(
      JSON.stringify({ version: 1, subtitleStyle: 'not-an-object' }),
    );
    expect(nonObject.subtitleStyle).toBe(DEFAULT_SUBTITLE_STYLE);
  });

  it('round-trips through PreferencesStore with partial updates, corrupt patch safety, and reset', async () => {
    const backing = new Map<string, string>();
    const backend: PreferencesKvBackend = {
      get: (k) => backing.get(k),
      set: (k, v) => {
        backing.set(k, v);
      },
      delete: (k) => {
        backing.delete(k);
      },
    };

    const store = createKvPreferencesStore(backend);
    const initial = await store.load();
    expect(initial.subtitleStyle).toBe(DEFAULT_SUBTITLE_STYLE);

    const u1 = await store.update({ subtitleStyle: { fontSize: 'large', textColor: 'cyan' } });
    expect(u1.ok).toBe(true);
    if (u1.ok) {
      expect(u1.value.subtitleStyle).toEqual({
        fontSize: 'large',
        textColor: 'cyan',
        backgroundColor: 'translucent',
        edgeStyle: 'outline',
        verticalPosition: 'bottom',
      });
    }

    const u2 = await store.update({ subtitleStyle: { verticalPosition: 'top' } });
    expect(u2.ok).toBe(true);
    if (u2.ok) {
      expect(u2.value.subtitleStyle).toEqual({
        fontSize: 'large',
        textColor: 'cyan',
        backgroundColor: 'translucent',
        edgeStyle: 'outline',
        verticalPosition: 'top',
      });
    }

    const u3 = await store.update({
      subtitleStyle: {
        fontSize: 'invalid' as unknown as SubtitleStyleConfig['fontSize'],
        backgroundColor: 'none',
      },
    });
    expect(u3.ok).toBe(true);
    if (u3.ok) {
      expect(u3.value.subtitleStyle).toEqual({
        fontSize: 'large',
        textColor: 'cyan',
        backgroundColor: 'none',
        edgeStyle: 'outline',
        verticalPosition: 'top',
      });
    }

    // Rehydrate in a fresh store instance from the same KV backend
    const store2 = createKvPreferencesStore(backend);
    const reloaded = await store2.load();
    expect(reloaded.subtitleStyle).toEqual({
      fontSize: 'large',
      textColor: 'cyan',
      backgroundColor: 'none',
      edgeStyle: 'outline',
      verticalPosition: 'top',
    });

    // Resetting back to default style omits subtitleStyle from persisted JSON
    const u4 = await store2.update({ subtitleStyle: DEFAULT_SUBTITLE_STYLE });
    expect(u4.ok).toBe(true);
    const rawAfterDefault = [...backing.values()][0] ?? '';
    expect('subtitleStyle' in (JSON.parse(rawAfterDefault) as Record<string, unknown>)).toBe(false);

    // Memory store reset restores default
    const mem = createMemoryPreferencesStore({ subtitleStyle: { edgeStyle: 'dropShadow' } });
    expect((await mem.load()).subtitleStyle.edgeStyle).toBe('dropShadow');
    const resetRes = await mem.reset();
    expect(resetRes.ok).toBe(true);
    if (resetRes.ok) {
      expect(resetRes.value.subtitleStyle).toBe(DEFAULT_SUBTITLE_STYLE);
    }
  });
});
