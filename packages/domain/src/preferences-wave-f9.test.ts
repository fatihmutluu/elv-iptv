import { describe, expect, it } from 'vitest';
import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  isValidSyncServerUrl,
  MAX_PREFERENCES_BYTES,
  normalizeSyncServerUrl,
  parsePreferences,
  serializePreferences,
} from './index';

describe('Wave F9 preferences (#26, #458)', () => {
  it('exposes defaults and validates syncServerUrl safely', () => {
    expect(DEFAULT_PREFERENCES.telemetryOptIn).toBe(false);
    expect(DEFAULT_PREFERENCES.welcomeDismissed).toBe(false);
    expect(DEFAULT_PREFERENCES.syncServerUrl).toBe('');

    expect(isValidSyncServerUrl('')).toBe(true);
    expect(isValidSyncServerUrl('https://sync.example.com')).toBe(true);
    expect(isValidSyncServerUrl('https://SYNC.EXAMPLE.COM:8443/v1/')).toBe(true);
    expect(isValidSyncServerUrl('http://127.0.0.1:8787')).toBe(true);
    expect(isValidSyncServerUrl('http://localhost:8787/sync')).toBe(true);
    expect(isValidSyncServerUrl('http://[::1]:8787')).toBe(true);

    // Reject plaintext non-loopback, credentials, queries, fragments, non-http(s), control chars
    const invalidUrls = [
      'http://sync.example.com',
      'http://192.168.1.5:8787',
      'https://user:pass@sync.example.com',
      'https://token@sync.example.com',
      'https://sync.example.com?token=abc',
      'https://sync.example.com#frag',
      'ftp://sync.example.com',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://sync.example.com/a/../b',
      'https://sync.example.com/\nheader:bad',
      'https://sync.example.com/with space',
      `https://${'a'.repeat(260)}.example.com`,
    ];
    for (const bad of invalidUrls) {
      expect(isValidSyncServerUrl(bad)).toBe(false);
      expect(normalizeSyncServerUrl(bad, 'fallback')).toBe('fallback');
    }

    expect(normalizeSyncServerUrl('  HTTPS://Sync.Example.COM:443/  ')).toBe(
      'https://sync.example.com',
    );
    expect(normalizeSyncServerUrl('https://sync.example.com/api///')).toBe(
      'https://sync.example.com/api',
    );
    expect(normalizeSyncServerUrl('http://LOCALHOST:8787/')).toBe('http://localhost:8787');
    expect(normalizeSyncServerUrl('   ')).toBe('');
    expect(normalizeSyncServerUrl(123, 'fallback')).toBe('fallback');
  });

  it('round-trips valid Wave F9 preferences and omits default values from serialized JSON', () => {
    const defaultEncoded = serializePreferences(DEFAULT_PREFERENCES);
    expect(defaultEncoded.ok).toBe(true);
    if (defaultEncoded.ok) {
      const rawDefault = JSON.parse(defaultEncoded.value) as Record<string, unknown>;
      expect(rawDefault.telemetryOptIn).toBeUndefined();
      expect(rawDefault.welcomeDismissed).toBeUndefined();
      expect(rawDefault.syncServerUrl).toBeUndefined();
    }

    const encoded = serializePreferences({
      ...DEFAULT_PREFERENCES,
      telemetryOptIn: true,
      welcomeDismissed: true,
      syncServerUrl: 'https://Sync.Example.com/api/',
    });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(new TextEncoder().encode(encoded.value).byteLength).toBeLessThan(MAX_PREFERENCES_BYTES);

    const parsed = parsePreferences(encoded.value);
    expect(parsed.telemetryOptIn).toBe(true);
    expect(parsed.welcomeDismissed).toBe(true);
    expect(parsed.syncServerUrl).toBe('https://sync.example.com/api');
  });

  it('rejects invalid types and unsafe sync URLs on parse and store update', async () => {
    const parsed = parsePreferences(
      JSON.stringify({
        version: 1,
        telemetryOptIn: 'yes',
        welcomeDismissed: 1,
        syncServerUrl: 'https://user:secret@evil.example.com',
      }),
    );
    expect(parsed.telemetryOptIn).toBe(false);
    expect(parsed.welcomeDismissed).toBe(false);
    expect(parsed.syncServerUrl).toBe('');

    const store = createMemoryPreferencesStore();
    await store.load();
    const updated = await store.update({
      telemetryOptIn: true,
      welcomeDismissed: true,
      syncServerUrl: 'http://127.0.0.1:8787/',
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.telemetryOptIn).toBe(true);
    expect(updated.value.welcomeDismissed).toBe(true);
    expect(updated.value.syncServerUrl).toBe('http://127.0.0.1:8787');

    // Invalid URL update keeps previous valid value
    const rejected = await store.update({
      syncServerUrl: 'http://insecure.example.com',
    });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.syncServerUrl).toBe('http://127.0.0.1:8787');

    const cleared = await store.update({
      telemetryOptIn: false,
      syncServerUrl: '',
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.value.telemetryOptIn).toBe(false);
    expect(cleared.value.syncServerUrl).toBe('');
  });
});
