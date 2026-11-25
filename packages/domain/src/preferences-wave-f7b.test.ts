import { describe, expect, it } from 'vitest';
import {
  createMemoryPreferencesStore,
  DEFAULT_PREFERENCES,
  EXTERNAL_PLAYER_MODES,
  isExternalPlayerMode,
  isValidExternalPlayerScheme,
  MAX_PREFERENCES_BYTES,
  normalizeExternalPlayerScheme,
  parsePreferences,
  serializePreferences,
} from './index';

describe('Wave F7B preferences (#226, #406)', () => {
  it('exposes constants, defaults, and validators', () => {
    expect(EXTERNAL_PLAYER_MODES).toEqual(['off', 'ask', 'always']);
    expect(DEFAULT_PREFERENCES.crashReportsOptIn).toBe(false);
    expect(DEFAULT_PREFERENCES.crashReportsIncludeLogs).toBe(false);
    expect(DEFAULT_PREFERENCES.externalPlayerMode).toBe('off');
    expect(DEFAULT_PREFERENCES.externalPlayerCustomScheme).toBe('');

    expect(isExternalPlayerMode('off')).toBe(true);
    expect(isExternalPlayerMode('ask')).toBe(true);
    expect(isExternalPlayerMode('always')).toBe(true);
    expect(isExternalPlayerMode('auto')).toBe(false);

    expect(isValidExternalPlayerScheme('')).toBe(true);
    expect(isValidExternalPlayerScheme('myplayer')).toBe(true);
    expect(isValidExternalPlayerScheme('app-player+1.0')).toBe(true);
    expect(isValidExternalPlayerScheme('1invalid')).toBe(false);
    expect(isValidExternalPlayerScheme('http://example.com')).toBe(false);
    expect(isValidExternalPlayerScheme('user:pass@host')).toBe(false);
    expect(isValidExternalPlayerScheme('a'.repeat(33))).toBe(false);

    expect(normalizeExternalPlayerScheme('  My-Player  ')).toBe('my-player');
    expect(normalizeExternalPlayerScheme('https://evil.test/x', 'fallback')).toBe('fallback');
    expect(normalizeExternalPlayerScheme('')).toBe('');

    const blockedSchemes = [
      'http',
      'https',
      'file',
      'tel',
      'sms',
      'mailto',
      'javascript',
      'data',
      'blob',
      'about',
      'elviptv',
      'ftp',
      'ws',
      'wss',
      'HTTPS',
      'JavaScript',
      'ELVIPTV',
    ];
    for (const scheme of blockedSchemes) {
      expect(isValidExternalPlayerScheme(scheme)).toBe(false);
      expect(normalizeExternalPlayerScheme(scheme, 'fallback')).toBe('fallback');
    }
  });

  it('round-trips valid Wave F7B preferences and omits default values from serialized JSON', () => {
    const defaultEncoded = serializePreferences(DEFAULT_PREFERENCES);
    expect(defaultEncoded.ok).toBe(true);
    if (defaultEncoded.ok) {
      const rawDefault = JSON.parse(defaultEncoded.value) as Record<string, unknown>;
      expect(rawDefault.crashReportsOptIn).toBeUndefined();
      expect(rawDefault.crashReportsIncludeLogs).toBeUndefined();
      expect(rawDefault.externalPlayerMode).toBeUndefined();
      expect(rawDefault.externalPlayerCustomScheme).toBeUndefined();
    }

    const encoded = serializePreferences({
      ...DEFAULT_PREFERENCES,
      crashReportsOptIn: true,
      crashReportsIncludeLogs: true,
      externalPlayerMode: 'ask',
      externalPlayerCustomScheme: 'Custom-Player.1',
    });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(new TextEncoder().encode(encoded.value).byteLength).toBeLessThan(MAX_PREFERENCES_BYTES);

    const parsed = parsePreferences(encoded.value);
    expect(parsed.crashReportsOptIn).toBe(true);
    expect(parsed.crashReportsIncludeLogs).toBe(true);
    expect(parsed.externalPlayerMode).toBe('ask');
    expect(parsed.externalPlayerCustomScheme).toBe('custom-player.1');
  });

  it('rejects invalid types and unsafe schemes on parse and store update', async () => {
    const parsed = parsePreferences(
      JSON.stringify({
        version: 1,
        crashReportsOptIn: 'yes',
        crashReportsIncludeLogs: 1,
        externalPlayerMode: 'force',
        externalPlayerCustomScheme: 'http://user:pass@evil.test/stream.ts',
      }),
    );
    expect(parsed.crashReportsOptIn).toBe(false);
    expect(parsed.crashReportsIncludeLogs).toBe(false);
    expect(parsed.externalPlayerMode).toBe('off');
    expect(parsed.externalPlayerCustomScheme).toBe('');

    const store = createMemoryPreferencesStore();
    await store.load();
    const updated = await store.update({
      crashReportsOptIn: true,
      crashReportsIncludeLogs: true,
      externalPlayerMode: 'always',
      externalPlayerCustomScheme: 'openplayer',
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.crashReportsOptIn).toBe(true);
    expect(updated.value.crashReportsIncludeLogs).toBe(true);
    expect(updated.value.externalPlayerMode).toBe('always');
    expect(updated.value.externalPlayerCustomScheme).toBe('openplayer');

    const cleared = await store.update({
      externalPlayerCustomScheme: '',
      externalPlayerMode: 'off',
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.value.externalPlayerCustomScheme).toBe('');
    expect(cleared.value.externalPlayerMode).toBe('off');
  });
});
