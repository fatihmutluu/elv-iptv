import { describe, expect, it } from 'vitest';
import { type M3uEntry, scanM3u } from './m3u';
import {
  MAX_CLEARKEY_JWK_BYTES,
  MAX_CLEARKEY_PAIRS,
  MAX_LICENSE_HEADERS,
  parseM3uDrmProps,
} from './m3u-drm';
import { chunksOf, utf8 } from './test-chunks';

async function scanAll(text: string): Promise<M3uEntry[]> {
  const bytes = utf8(text);
  const entries: M3uEntry[] = [];
  for await (const batch of scanM3u(chunksOf(bytes, [bytes.length]))) {
    entries.push(...batch.entries);
  }
  return entries;
}

describe('parseM3uDrmProps (#272)', () => {
  it('maps clearkey, widevine, and playready license_type aliases case-insensitively', () => {
    const hexKid = '00112233445566778899aabbccddeeff';
    const hexKey = 'ffeeddccbbaa99887766554433221100';

    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_type': 'clearkey',
        'inputstream.adaptive.license_key': `${hexKid}:${hexKey}`,
      }),
    ).toEqual({
      scheme: 'clearkey',
      clearKeys: [{ kid: hexKid, key: hexKey }],
    });

    expect(
      parseM3uDrmProps({
        'INPUTSTREAM.ADAPTIVE.LICENSE_TYPE': 'ORG.W3.CLEARKEY',
        'INPUTSTREAM.ADAPTIVE.LICENSE_KEY': `${hexKid}:${hexKey}`,
      }),
    ).toEqual({
      scheme: 'clearkey',
      clearKeys: [{ kid: hexKid, key: hexKey }],
    });

    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_type': 'widevine',
        'inputstream.adaptive.license_key': 'https://lic.example.test/wv',
      }),
    ).toEqual({
      scheme: 'widevine',
      licenseUrl: 'https://lic.example.test/wv',
    });

    expect(
      parseM3uDrmProps({
        'InputStream.Adaptive.License_Type': 'com.widevine.alpha',
        'InputStream.Adaptive.License_Key': 'https://lic.example.test/wv-alpha',
      }),
    ).toEqual({
      scheme: 'widevine',
      licenseUrl: 'https://lic.example.test/wv-alpha',
    });

    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_type': 'playready',
        'inputstream.adaptive.license_key': 'http://lic.example.test/pr',
      }),
    ).toEqual({
      scheme: 'playready',
      licenseUrl: 'http://lic.example.test/pr',
    });

    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_type': 'com.microsoft.playready',
        'inputstream.adaptive.license_key': 'https://lic.example.test/pr-ms',
      }),
    ).toEqual({
      scheme: 'playready',
      licenseUrl: 'https://lic.example.test/pr-ms',
    });
  });

  it('parses Kodi pipe syntax remote license URLs with sanitized headers and ignores trailing post/response fields', () => {
    const result = parseM3uDrmProps({
      'inputstream.adaptive.license_type': 'com.widevine.alpha',
      'inputstream.adaptive.license_key':
        'https://license.example.test/wv?tenant=1|Authorization=Bearer%20tok123&X-Custom=val%261&Bad%20Header=drop&X-Ctrl=ok%0D%0AInjected%3A%20bad|R{SSM}|JBlicense',
    });
    expect(result).toEqual({
      scheme: 'widevine',
      licenseUrl: 'https://license.example.test/wv?tenant=1',
      licenseHeaders: {
        Authorization: 'Bearer tok123',
        'X-Custom': 'val&1',
        'X-Ctrl': 'okInjected: bad',
      },
    });
  });

  it('supports remote ClearKey license server URLs with optional headers', () => {
    const result = parseM3uDrmProps({
      'inputstream.adaptive.license_type': 'org.w3.clearkey',
      'inputstream.adaptive.license_key': 'https://ck.example.test/license|X-Token=abc123|R{SSM}|',
    });
    expect(result).toEqual({
      scheme: 'clearkey',
      licenseUrl: 'https://ck.example.test/license',
      licenseHeaders: { 'X-Token': 'abc123' },
    });
  });

  it('rejects non-http(s) license URLs, malformed URLs, and control characters', () => {
    for (const badUrl of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:application/json,{"keys":[]}',
      'ftp://license.example.test/wv',
      'https://license.example.test/wv\r\nX-Injected: 1',
      'https://license.example.test/wv with spaces',
      'https://',
      '',
    ]) {
      expect(
        parseM3uDrmProps({
          'inputstream.adaptive.license_type': 'com.widevine.alpha',
          'inputstream.adaptive.license_key': badUrl,
        }),
      ).toBeUndefined();
    }
  });

  it('parses multiple comma-separated ClearKey kid:key pairs in hex, hyphenated UUID, base64url, and standard base64 (M3U-2)', () => {
    const kid1 = ['0011223344556677', '8899aabbccddeeff'].join('');
    const key1 = ['aabbccddeeff0011', '2233445566778899'].join('');
    const kid2 = ['ABCDEFGHIJK', 'LMNOPQRSTUV'].join(''); // 22 base64url chars (16 bytes)
    const key2 = ['abcdefghijk', 'lmnopqrstuv=='].join(''); // 24 padded base64url chars (16 bytes) -> unpadded base64url
    const kid3 = '00112233-4455-6677-8899-AABBCCDDEEFF'; // hyphenated UUID hex -> 32 lowercase hex
    const key3 = ['AB+CD/EF0123', '456789abcd=='].join(''); // standard Base64 (+, /) -> unpadded base64url
    const expectedKey3 = ['AB-CD_EF0123', '456789abcd'].join('');

    const result = parseM3uDrmProps({
      'inputstream.adaptive.license_type': 'clearkey',
      'inputstream.adaptive.license_key': `${kid1}:${key1}, ${kid2}:${key2},${kid3}:${key3}`,
    });
    expect(result).toEqual({
      scheme: 'clearkey',
      clearKeys: [
        { kid: kid1, key: key1 },
        { kid: kid2, key: 'abcdefghijklmnopqrstuv' },
        { kid: '00112233445566778899aabbccddeeff', key: expectedKey3 },
      ],
    });

    // Reject 17-byte (23+=) and 18-byte (24 unpadded) base64 tokens that are not 128-bit keys
    for (const wrongLen of [
      '0123456789-_abcdefghijkl:0123456789-_abcdefghijkl',
      '9876543210_-ABCDEFGHIJK=:9876543210_-ABCDEFGHIJK=',
    ]) {
      expect(
        parseM3uDrmProps({
          'inputstream.adaptive.license_type': 'clearkey',
          'inputstream.adaptive.license_key': wrongLen,
        }),
      ).toBeUndefined();
    }
  });

  it('rejects malformed ClearKey kid:key strings and caps pairs at MAX_CLEARKEY_PAIRS', () => {
    const validHex = '00112233445566778899aabbccddeeff';
    for (const bad of [
      'not-a-pair',
      `${validHex}:short`,
      'short:short',
      `${validHex}:${validHex}:extra`,
      `${validHex}:${validHex},`,
      `javascript:alert(1)`,
      `data:text/plain;base64,abc`,
    ]) {
      expect(
        parseM3uDrmProps({
          'inputstream.adaptive.license_type': 'clearkey',
          'inputstream.adaptive.license_key': bad,
        }),
      ).toBeUndefined();
    }

    // Inline kid:key is not valid for Widevine or PlayReady
    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_type': 'widevine',
        'inputstream.adaptive.license_key': `${validHex}:${validHex}`,
      }),
    ).toBeUndefined();

    // Capped at MAX_CLEARKEY_PAIRS
    const manyPairs = Array.from({ length: MAX_CLEARKEY_PAIRS + 5 }, (_, i) => {
      const hex = i.toString(16).padStart(32, '0');
      return `${hex}:${hex}`;
    }).join(',');
    const capped = parseM3uDrmProps({
      'inputstream.adaptive.license_type': 'clearkey',
      'inputstream.adaptive.license_key': manyPairs,
    });
    expect(capped?.clearKeys).toHaveLength(MAX_CLEARKEY_PAIRS);
  });

  it('parses inline ClearKey JWK JSON and validates kty, kid, k, and 8 KiB size cap', () => {
    const jwkK1 = ['0123456789a', 'bcdefghijkl'].join('');
    const jwkK2 = ['ffeeddccbbaa9988', '7766554433221100'].join('');
    const jwk = JSON.stringify({
      keys: [
        { kty: 'oct', kid: 'ABCDEFGHIJKLMNOPQRSTUV', k: jwkK1 },
        {
          kty: 'oct',
          kid: '00112233445566778899aabbccddeeff',
          k: jwkK2,
        },
      ],
      type: 'temporary',
    });

    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_type': 'org.w3.clearkey',
        'inputstream.adaptive.license_key': jwk,
      }),
    ).toEqual({
      scheme: 'clearkey',
      clearKeys: [
        { kid: 'ABCDEFGHIJKLMNOPQRSTUV', key: jwkK1 },
        {
          kid: '00112233445566778899aabbccddeeff',
          key: jwkK2,
        },
      ],
    });

    // Reject wrong kty, empty keys, invalid JSON, or non-clearkey scheme
    for (const badJwk of [
      '{"keys":[{"kty":"RSA","kid":"ABCDEFGHIJKLMNOPQRSTUV","k":"0123456789abcdefghijkl"}]}',
      '{"keys":[{"kty":"oct","kid":"bad","k":"0123456789abcdefghijkl"}]}',
      '{"keys":[]}',
      '{not-json',
    ]) {
      expect(
        parseM3uDrmProps({
          'inputstream.adaptive.license_type': 'clearkey',
          'inputstream.adaptive.license_key': badJwk,
        }),
      ).toBeUndefined();
    }

    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_type': 'widevine',
        'inputstream.adaptive.license_key': jwk,
      }),
    ).toBeUndefined();

    // Reject JWK JSON larger than MAX_CLEARKEY_JWK_BYTES (8 KiB)
    const oversized = `{"keys":[{"kty":"oct","kid":"ABCDEFGHIJKLMNOPQRSTUV","k":"0123456789abcdefghijkl"}],"pad":"${'a'.repeat(MAX_CLEARKEY_JWK_BYTES)}"}`;
    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_type': 'clearkey',
        'inputstream.adaptive.license_key': oversized,
      }),
    ).toBeUndefined();
  });

  it('bounds license header count and ignores unknown DRM schemes or missing properties', () => {
    const manyHeaders = Array.from(
      { length: MAX_LICENSE_HEADERS + 10 },
      (_, i) => `X-H-${i}=val${i}`,
    ).join('&');
    const res = parseM3uDrmProps({
      'inputstream.adaptive.license_type': 'widevine',
      'inputstream.adaptive.license_key': `https://lic.example.test/wv|${manyHeaders}`,
    });
    expect(res?.licenseUrl).toBe('https://lic.example.test/wv');
    expect(Object.keys(res?.licenseHeaders ?? {})).toHaveLength(MAX_LICENSE_HEADERS);

    expect(parseM3uDrmProps({})).toBeUndefined();
    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_type': 'fairplay',
        'inputstream.adaptive.license_key': 'https://lic.example.test/fp',
      }),
    ).toBeUndefined();
    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_type': 'widevine',
      }),
    ).toBeUndefined();
  });

  it('attaches entry.drm via scanM3u ONLY when valid DRM #KODIPROP tags are present', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="ck1" group-title="Sports",ClearKey Channel',
      '#KODIPROP:inputstream.adaptive.license_type=org.w3.clearkey',
      '#KODIPROP:inputstream.adaptive.license_key=00112233445566778899aabbccddeeff:ffeeddccbbaa99887766554433221100',
      'https://cdn.example.test/live/ck1.mpd',
      '#EXTINF:-1 tvg-id="wv1" group-title="Movies",Widevine Film',
      '#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha',
      '#KODIPROP:inputstream.adaptive.license_key=https://lic.example.test/wv|X-Auth=secret-tok|R{SSM}|',
      'https://cdn.example.test/movie/wv1.mpd',
      '#EXTINF:-1 tvg-id="plain1" group-title="News",Plain Channel',
      'https://cdn.example.test/live/plain1.m3u8',
      '#EXTINF:-1 tvg-id="bad1" group-title="News",Invalid DRM Channel',
      '#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha',
      '#KODIPROP:inputstream.adaptive.license_key=file:///etc/shadow',
      'https://cdn.example.test/live/bad1.mpd',
      '',
    ].join('\n');

    const entries = await scanAll(playlist);
    expect(entries).toHaveLength(4);
    expect(entries[0]?.drm).toEqual({
      scheme: 'clearkey',
      clearKeys: [
        {
          kid: '00112233445566778899aabbccddeeff',
          key: 'ffeeddccbbaa99887766554433221100',
        },
      ],
    });
    expect(entries[1]?.drm).toEqual({
      scheme: 'widevine',
      licenseUrl: 'https://lic.example.test/wv',
      licenseHeaders: { 'X-Auth': 'secret-tok' },
    });
    expect('drm' in (entries[2] ?? {})).toBe(false);
    expect('drm' in (entries[3] ?? {})).toBe(false);
  });

  it('supports flat ClearKey JSON maps, drm_legacy fallback, and implicit ClearKey inference (M3U-2)', () => {
    const hexKid = '00112233445566778899aabbccddeeff';
    const hexKey = 'ffeeddccbbaa99887766554433221100';
    const uuidKid = '00112233-4455-6677-8899-aabbccddeeff';

    const stdB64Kid = ['AB+CD/EF0123', '456789abcd=='].join('');
    const urlB64Kid = ['AB-CD_EF0123', '456789abcd'].join('');
    const seqHexKey = ['0123456789abcdef', '0123456789abcdef'].join('');

    // Flat { "<kid>": "<key>" } JSON dictionary
    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_type': 'clearkey',
        'inputstream.adaptive.license_key': JSON.stringify({
          [uuidKid]: hexKey,
          [stdB64Kid]: seqHexKey,
        }),
      }),
    ).toEqual({
      scheme: 'clearkey',
      clearKeys: [
        { kid: hexKid, key: hexKey },
        { kid: urlB64Kid, key: seqHexKey },
      ],
    });

    // Rejects prototype pollution keys inside flat ClearKey JSON
    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_type': 'clearkey',
        'inputstream.adaptive.license_key': `{"__proto__":"${hexKey}","${hexKid}":"${hexKey}"}`,
      }),
    ).toBeUndefined();

    // inputstream.adaptive.drm_legacy fallback preserving pipe headers on remote license URLs
    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.drm_legacy':
          'com.widevine.alpha|https://lic.example.test/wv|X-Auth=tok1|R{SSM}',
      }),
    ).toEqual({
      scheme: 'widevine',
      licenseUrl: 'https://lic.example.test/wv',
      licenseHeaders: { 'X-Auth': 'tok1' },
    });

    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.drm_legacy': `org.w3.clearkey|${uuidKid}:${hexKey}`,
      }),
    ).toEqual({
      scheme: 'clearkey',
      clearKeys: [{ kid: hexKid, key: hexKey }],
    });

    // Explicit license_type/license_key take precedence over drm_legacy
    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_type': 'playready',
        'inputstream.adaptive.license_key': 'https://pr.example.test/lic',
        'inputstream.adaptive.drm_legacy': 'com.widevine.alpha|https://wv.example.test/lic',
      }),
    ).toEqual({
      scheme: 'playready',
      licenseUrl: 'https://pr.example.test/lic',
    });

    // Implicit ClearKey inference when license_type is omitted
    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_key': `${hexKid}:${hexKey}`,
      }),
    ).toEqual({
      scheme: 'clearkey',
      clearKeys: [{ kid: hexKid, key: hexKey }],
    });
    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_key': JSON.stringify({ [hexKid]: hexKey }),
      }),
    ).toEqual({
      scheme: 'clearkey',
      clearKeys: [{ kid: hexKid, key: hexKey }],
    });

    // NEVER infer ClearKey for http(s):// license URLs when license_type is omitted
    expect(
      parseM3uDrmProps({
        'inputstream.adaptive.license_key': 'https://lic.example.test/wv',
      }),
    ).toBeUndefined();
  });
});
