import { describe, expect, it } from 'vitest';
import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  type HttpRequestOptions,
  MAX_PREFERENCES_BYTES,
  parsePreferences,
  serializePreferences,
  type TransportSettings,
  transportHeaders,
} from './index';

describe('Wave C3 preferences & transport (#182, #218, #404)', () => {
  it('exposes Wave C3 defaults on DEFAULT_PREFERENCES', () => {
    expect(DEFAULT_PREFERENCES.collapseLiveVariants).toBe(false);
    expect(DEFAULT_PREFERENCES.groupVodVersions).toBe(true);
  });

  it('parses valid boolean values and falls back to defaults on invalid inputs', () => {
    const parsed = parsePreferences(
      JSON.stringify({
        version: 1,
        collapseLiveVariants: true,
        groupVodVersions: false,
      }),
    );
    expect(parsed.collapseLiveVariants).toBe(true);
    expect(parsed.groupVodVersions).toBe(false);

    for (const bad of ['true', 'false', 1, 0, null, {}]) {
      const p = parsePreferences(
        JSON.stringify({
          version: 1,
          collapseLiveVariants: bad,
          groupVodVersions: bad,
        }),
      );
      expect(p.collapseLiveVariants).toBe(false);
      expect(p.groupVodVersions).toBe(true);
    }
  });

  it('round-trips via serializePreferences within MAX_PREFERENCES_BYTES', () => {
    const encoded = serializePreferences({
      ...DEFAULT_PREFERENCES,
      collapseLiveVariants: true,
      groupVodVersions: false,
    });
    expect(encoded.ok).toBe(true);
    if (encoded.ok) {
      expect(new TextEncoder().encode(encoded.value).byteLength).toBeLessThan(
        MAX_PREFERENCES_BYTES,
      );
      const parsed = parsePreferences(encoded.value);
      expect(parsed.collapseLiveVariants).toBe(true);
      expect(parsed.groupVodVersions).toBe(false);
    }
  });

  it('merges, ignores invalid patches, and resets via PreferencesStore', async () => {
    const store = createMemoryPreferencesStore();

    const u1 = await store.update({
      collapseLiveVariants: true,
      groupVodVersions: false,
    });
    expect(u1.ok).toBe(true);
    if (u1.ok) {
      expect(u1.value.collapseLiveVariants).toBe(true);
      expect(u1.value.groupVodVersions).toBe(false);
    }

    const u2 = await store.update({
      collapseLiveVariants: 'yes' as unknown as boolean,
      groupVodVersions: 123 as unknown as boolean,
    });
    expect(u2.ok).toBe(true);
    if (u2.ok) {
      expect(u2.value.collapseLiveVariants).toBe(true);
      expect(u2.value.groupVodVersions).toBe(false);
    }

    const reset = await store.reset();
    expect(reset.ok).toBe(true);
    if (reset.ok) {
      expect(reset.value.collapseLiveVariants).toBe(false);
      expect(reset.value.groupVodVersions).toBe(true);
    }
  });

  it('accepts allowLegacyTls on TransportSettings and HttpRequestOptions without leaking headers', () => {
    const transport: TransportSettings = {
      userAgent: 'TestAgent/1.0',
      allowLegacyTls: true,
    };
    const headers = transportHeaders(transport);
    expect(headers).toEqual({ 'user-agent': 'TestAgent/1.0' });

    const reqOpts: HttpRequestOptions = {
      allowLegacyTls: true,
      timeoutMs: 5000,
    };
    expect(reqOpts.allowLegacyTls).toBe(true);
  });
});
