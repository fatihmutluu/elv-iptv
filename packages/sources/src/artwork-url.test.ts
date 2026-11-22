import { describe, expect, it } from 'vitest';
import { MAX_INLINE_LOGO_BYTES, sanitizeArtworkUrl } from './artwork-url';

describe('sanitizeArtworkUrl (#428)', () => {
  it('accepts valid http:// and https:// URLs with non-empty hosts and trims whitespace', () => {
    expect(sanitizeArtworkUrl('http://img.example/logo.png')).toEqual({
      url: 'http://img.example/logo.png',
    });
    expect(sanitizeArtworkUrl('  HTTPS://CDN.EXAMPLE:8443/a/b.webp?v=1#top  ')).toEqual({
      url: 'HTTPS://CDN.EXAMPLE:8443/a/b.webp?v=1#top',
    });
    expect(sanitizeArtworkUrl('http://[::1]:8080/icon.png')).toEqual({
      url: 'http://[::1]:8080/icon.png',
    });
    expect(sanitizeArtworkUrl('http://img.example/My Channel.png')).toEqual({
      url: 'http://img.example/My Channel.png',
    });
  });

  it('accepts bounded non-SVG data:image/* URIs up to MAX_INLINE_LOGO_BYTES', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(sanitizeArtworkUrl(png)).toEqual({ url: png });

    const jpeg = 'DATA:image/jpeg;base64,AAAA';
    expect(sanitizeArtworkUrl(jpeg)).toEqual({ url: jpeg });

    const webp = 'data:image/webp;charset=utf-8;base64,AAAA';
    expect(sanitizeArtworkUrl(webp)).toEqual({ url: webp });

    const prefix = 'data:image/png;base64,';
    const exact = prefix + 'A'.repeat(MAX_INLINE_LOGO_BYTES - prefix.length);
    expect(exact.length).toBe(MAX_INLINE_LOGO_BYTES);
    expect(sanitizeArtworkUrl(exact)).toEqual({ url: exact });
  });

  it('flags oversized data: URIs (> MAX_INLINE_LOGO_BYTES) as oversizedData without returning url', () => {
    const prefix = 'data:image/png;base64,';
    const over = prefix + 'A'.repeat(MAX_INLINE_LOGO_BYTES - prefix.length + 1);
    expect(sanitizeArtworkUrl(over)).toEqual({ oversizedData: true });

    const overUpper = `DATA:image/jpeg;base64,${'B'.repeat(5000)}`;
    expect(sanitizeArtworkUrl(overUpper)).toEqual({ oversizedData: true });
  });

  it('rejects SVG data URIs, non-image data URIs, unsafe schemes, control chars, relative paths, and empty hosts', () => {
    const rejected = [
      '',
      '   ',
      'data:image/svg+xml,<svg/>',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'DATA:image/SVG+XML;utf8,<svg/>',
      'data:image/svg,<svg/>',
      'data:text/html,<script>alert(1)</script>',
      'data:application/javascript,alert(1)',
      'data:image/png;base64',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'JAVASCRIPT:void(0)',
      'ftp://cdn.example/logo.png',
      'content://media/external/images/1',
      '//cdn.example/logo.png',
      '/logos/ch1.png',
      'logos/ch1.png',
      'q',
      'http:///no-host.png',
      'https://:443/no-host.png',
      'http://user@/no-host.png',
      'http://bad host.example/a.png',
      'http://[]/empty-v6.png',
      'http://img.example/a\nb.png',
      'http://img.example/a\rb.png',
      'http://img.example/a\tb.png',
      'http://img.example/a\u0000b.png',
      'http://img.example/a\u007fb.png',
    ];
    for (const raw of rejected) {
      expect(sanitizeArtworkUrl(raw), raw).toEqual({});
    }
  });
});
