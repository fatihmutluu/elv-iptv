import { describe, expect, it } from 'vitest';
import {
  buildLanPairingUrl,
  constantTimeEqual,
  isPrivateLanAddress,
  isValidPairingHostHeader,
  isValidPairingOrigin,
  isValidPairingPath,
  isValidPairingToken,
  LAN_PAIRING_MAX_BODY_BYTES,
  LAN_PAIRING_MAX_FAILED_ATTEMPTS,
  LAN_PAIRING_TTL_MS,
  parseLanPairingPayload,
  renderLanPairingHtml,
} from './lan-pairing-protocol';

const VALID_TOKEN = 'a'.repeat(32);

describe('LAN pairing protocol constants & token helpers', () => {
  it('exposes spec-mandated security constants', () => {
    expect(LAN_PAIRING_TTL_MS).toBe(300_000);
    expect(LAN_PAIRING_MAX_BODY_BYTES).toBe(16_384);
    expect(LAN_PAIRING_MAX_FAILED_ATTEMPTS).toBe(5);
  });

  it('validates >= 32 hex char tokens and rejects weak or malformed tokens', () => {
    expect(isValidPairingToken(VALID_TOKEN)).toBe(true);
    expect(isValidPairingToken('ABCDEF0123456789abcdef0123456789abcdef0123456789')).toBe(true);
    expect(isValidPairingToken('0123456789abcdef0123456789abcde')).toBe(false);
    expect(isValidPairingToken('g123456789abcdef0123456789abcdef')).toBe(false);
    expect(isValidPairingToken('0123456789abcdef 0123456789abcdef')).toBe(false);
    expect(isValidPairingToken('')).toBe(false);
    expect(isValidPairingToken('a'.repeat(129))).toBe(false);
  });

  it('compares strings in constant time', () => {
    expect(constantTimeEqual(VALID_TOKEN, VALID_TOKEN)).toBe(true);
    expect(constantTimeEqual(VALID_TOKEN, `${VALID_TOKEN.slice(0, -1)}0`)).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('a', '')).toBe(false);
  });

  it('builds pairing URLs for IPv4 and IPv6 hosts and validates request paths', () => {
    expect(buildLanPairingUrl('192.168.1.42', 41234, VALID_TOKEN)).toBe(
      `http://192.168.1.42:41234/pair/${VALID_TOKEN}`,
    );
    expect(buildLanPairingUrl('fd00::10', 41234, VALID_TOKEN)).toBe(
      `http://[fd00::10]:41234/pair/${VALID_TOKEN}`,
    );
    expect(buildLanPairingUrl('[fe80::1]', 8080, VALID_TOKEN)).toBe(
      `http://[fe80::1]:8080/pair/${VALID_TOKEN}`,
    );

    expect(isValidPairingPath(`/pair/${VALID_TOKEN}`, VALID_TOKEN)).toBe(true);
    expect(isValidPairingPath(`/pair/${VALID_TOKEN}?x=1`, VALID_TOKEN)).toBe(true);
    expect(isValidPairingPath(`/pair/${VALID_TOKEN}/extra`, VALID_TOKEN)).toBe(false);
    expect(isValidPairingPath('/pair/wrong', VALID_TOKEN)).toBe(false);
    expect(isValidPairingPath('/other', VALID_TOKEN)).toBe(false);
    expect(isValidPairingPath(`/pair/${VALID_TOKEN}`, 'short')).toBe(false);
  });
});

describe('isPrivateLanAddress', () => {
  it('accepts RFC1918 IPv4 addresses', () => {
    expect(isPrivateLanAddress('10.0.0.1')).toBe(true);
    expect(isPrivateLanAddress('10.255.255.254')).toBe(true);
    expect(isPrivateLanAddress('172.16.0.1')).toBe(true);
    expect(isPrivateLanAddress('172.31.255.254')).toBe(true);
    expect(isPrivateLanAddress('192.168.0.1')).toBe(true);
    expect(isPrivateLanAddress('192.168.255.254')).toBe(true);
  });

  it('accepts loopback, IPv4-mapped IPv6 private, IPv6 ULA, and IPv6 link-local addresses', () => {
    expect(isPrivateLanAddress('127.0.0.1')).toBe(true);
    expect(isPrivateLanAddress('::1')).toBe(true);
    expect(isPrivateLanAddress('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isPrivateLanAddress('::ffff:192.168.1.25')).toBe(true);
    expect(isPrivateLanAddress('::FFFF:10.0.0.5')).toBe(true);
    expect(isPrivateLanAddress('::ffff:172.20.10.2')).toBe(true);
    expect(isPrivateLanAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateLanAddress('::ffff:c0a8:0105')).toBe(true);
    expect(isPrivateLanAddress('fc00::1')).toBe(true);
    expect(isPrivateLanAddress('fd12:3456:789a::1')).toBe(true);
    expect(isPrivateLanAddress('fe80::1')).toBe(true);
    expect(isPrivateLanAddress('fe80::a1b2:c3d4:e5f6:1234%wlan0')).toBe(true);
    expect(isPrivateLanAddress('febf::1')).toBe(true);
  });

  it('rejects public IPs, CGNAT, multicast, cloud metadata, and unspecified addresses', () => {
    expect(isPrivateLanAddress('8.8.8.8')).toBe(false);
    expect(isPrivateLanAddress('1.1.1.1')).toBe(false);
    expect(isPrivateLanAddress('172.15.255.255')).toBe(false);
    expect(isPrivateLanAddress('172.32.0.1')).toBe(false);
    expect(isPrivateLanAddress('192.167.1.1')).toBe(false);
    expect(isPrivateLanAddress('192.169.1.1')).toBe(false);
    expect(isPrivateLanAddress('100.64.0.1')).toBe(false);
    expect(isPrivateLanAddress('100.127.255.254')).toBe(false);
    expect(isPrivateLanAddress('169.254.169.254')).toBe(false);
    expect(isPrivateLanAddress('224.0.0.1')).toBe(false);
    expect(isPrivateLanAddress('239.255.255.250')).toBe(false);
    expect(isPrivateLanAddress('255.255.255.255')).toBe(false);
    expect(isPrivateLanAddress('0.0.0.0')).toBe(false);
    expect(isPrivateLanAddress('::')).toBe(false);
    expect(isPrivateLanAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isPrivateLanAddress('::ffff:100.64.0.1')).toBe(false);
    expect(isPrivateLanAddress('2001:db8::1')).toBe(false);
    expect(isPrivateLanAddress('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateLanAddress('ff02::1')).toBe(false);
    expect(isPrivateLanAddress('fec0::1')).toBe(false);
  });

  it('rejects malformed addresses and injection inputs', () => {
    expect(isPrivateLanAddress('')).toBe(false);
    expect(isPrivateLanAddress('   ')).toBe(false);
    expect(isPrivateLanAddress('not-an-ip')).toBe(false);
    expect(isPrivateLanAddress('192.168.1')).toBe(false);
    expect(isPrivateLanAddress('192.168.1.256')).toBe(false);
    expect(isPrivateLanAddress('192.168.01.1')).toBe(false);
    expect(isPrivateLanAddress('192.168.1.1:8080')).toBe(false);
    expect(isPrivateLanAddress('192.168.1.1\r\n')).toBe(false);
    expect(isPrivateLanAddress(':::1')).toBe(false);
    expect(isPrivateLanAddress('fe80::1::2')).toBe(false);
    expect(isPrivateLanAddress('fe80::1%bad zone')).toBe(false);
    expect(isPrivateLanAddress('fe80::1%')).toBe(false);
    expect(isPrivateLanAddress('1:2:3:4:5:6:7:8:9')).toBe(false);
    expect(isPrivateLanAddress('1:2:3:4:5:6:7')).toBe(false);
    expect(isPrivateLanAddress('1:2:3:4:5:6:192.168.1.1:8')).toBe(false);
    expect(isPrivateLanAddress('::ffff:192.168.1.999')).toBe(false);
    expect(isPrivateLanAddress('::gggg')).toBe(false);
  });
});

describe('isValidPairingHostHeader & isValidPairingOrigin', () => {
  it('accepts exact Host matches and rejects DNS rebinding or wrong ports', () => {
    expect(isValidPairingHostHeader('192.168.1.20:45123', '192.168.1.20', 45123)).toBe(true);
    expect(isValidPairingHostHeader(' 192.168.1.20:45123 ', '192.168.1.20', 45123)).toBe(true);
    expect(isValidPairingHostHeader('192.168.1.20', '192.168.1.20', 80)).toBe(true);
    expect(isValidPairingHostHeader('192.168.1.20:80', '192.168.1.20', 80)).toBe(true);
    expect(isValidPairingHostHeader('[fd00::1]:8080', 'fd00::1', 8080)).toBe(true);
    expect(isValidPairingHostHeader('[FD00::1]:8080', '[fd00::1]', 8080)).toBe(true);

    expect(isValidPairingHostHeader(undefined, '192.168.1.20', 45123)).toBe(false);
    expect(isValidPairingHostHeader('', '192.168.1.20', 45123)).toBe(false);
    expect(isValidPairingHostHeader('192.168.1.20', '192.168.1.20', 45123)).toBe(false);
    expect(isValidPairingHostHeader('192.168.1.20:45124', '192.168.1.20', 45123)).toBe(false);
    expect(isValidPairingHostHeader('evil.example:45123', '192.168.1.20', 45123)).toBe(false);
    expect(isValidPairingHostHeader('192.168.1.20:45123', '', 45123)).toBe(false);
    expect(isValidPairingHostHeader('192.168.1.20:45123', '192.168.1.20', 0)).toBe(false);
    expect(isValidPairingHostHeader('192.168.1.20:45123', '192.168.1.20', 70000)).toBe(false);
  });

  it('allows absent Origin or exact same-origin http match, and rejects cross-origin sites', () => {
    expect(isValidPairingOrigin(undefined, '192.168.1.20', 45123)).toBe(true);
    expect(isValidPairingOrigin('http://192.168.1.20:45123', '192.168.1.20', 45123)).toBe(true);
    expect(isValidPairingOrigin('HTTP://192.168.1.20:45123', '192.168.1.20', 45123)).toBe(true);
    expect(isValidPairingOrigin('http://192.168.1.20', '192.168.1.20', 80)).toBe(true);
    expect(isValidPairingOrigin('http://[fd00::1]:8080', 'fd00::1', 8080)).toBe(true);

    expect(isValidPairingOrigin('', '192.168.1.20', 45123)).toBe(false);
    expect(isValidPairingOrigin('null', '192.168.1.20', 45123)).toBe(false);
    expect(isValidPairingOrigin('https://192.168.1.20:45123', '192.168.1.20', 45123)).toBe(false);
    expect(isValidPairingOrigin('http://192.168.1.20:45123/', '192.168.1.20', 45123)).toBe(false);
    expect(isValidPairingOrigin('https://evil.example', '192.168.1.20', 45123)).toBe(false);
    expect(isValidPairingOrigin('http://192.168.1.21:45123', '192.168.1.20', 45123)).toBe(false);
    expect(isValidPairingOrigin(undefined, '', 45123)).toBe(false);
    expect(isValidPairingOrigin(undefined, '192.168.1.20', -1)).toBe(false);
  });
});

describe('parseLanPairingPayload', () => {
  it('parses valid M3U JSON payloads with optional name and guideUrl', () => {
    const res = parseLanPairingPayload(
      JSON.stringify({
        kind: 'm3u',
        name: '  Living Room\u0007  ',
        url: 'https://provider.example/list.m3u8',
        guideUrl: 'https://provider.example/epg.xml.gz',
      }),
      'application/json; charset=utf-8',
    );
    expect(res).toEqual({
      ok: true,
      value: {
        kind: 'm3u',
        name: 'Living Room',
        url: 'https://provider.example/list.m3u8',
        guideUrl: 'https://provider.example/epg.xml.gz',
      },
    });
  });

  it('derives default hostname name when M3U name is omitted and omits blank guideUrl', () => {
    const res = parseLanPairingPayload(
      JSON.stringify({
        kind: 'm3u',
        url: 'http://streams.example.org/channels.m3u',
        guideUrl: '   ',
      }),
    );
    expect(res).toEqual({
      ok: true,
      value: {
        kind: 'm3u',
        name: 'streams.example.org',
        url: 'http://streams.example.org/channels.m3u',
      },
    });
  });

  it('parses valid Xtream URL-encoded form payloads and strips control chars', () => {
    const body = new URLSearchParams({
      kind: 'xtream',
      name: 'Family\u0000 TV',
      server: 'https://portal.example:8443',
      username: 'alice\u001f',
      password: 's3cr3t!\u007f',
      guideUrl: 'http://portal.example:8443/xmltv.php',
    }).toString();

    const res = parseLanPairingPayload(body, 'application/x-www-form-urlencoded; charset=UTF-8');
    expect(res).toEqual({
      ok: true,
      value: {
        kind: 'xtream',
        name: 'Family TV',
        server: 'https://portal.example:8443',
        username: 'alice',
        password: 's3cr3t!',
        guideUrl: 'http://portal.example:8443/xmltv.php',
      },
    });
  });

  it('auto-detects URL-encoded form payloads when contentType is omitted', () => {
    const body = 'kind=xtream&server=http%3A%2F%2Fiptv.example&username=u1&password=p1';
    const res = parseLanPairingPayload(body);
    expect(res).toEqual({
      ok: true,
      value: {
        kind: 'xtream',
        name: 'iptv.example',
        server: 'http://iptv.example',
        username: 'u1',
        password: 'p1',
      },
    });
  });

  it('rejects oversized bodies, bad content types, malformed JSON, and invalid kinds', () => {
    const oversized = JSON.stringify({
      kind: 'm3u',
      url: `https://example.com/${'a'.repeat(LAN_PAIRING_MAX_BODY_BYTES)}`,
    });
    const r1 = parseLanPairingPayload(oversized, 'application/json');
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.error.category).toBe('source-format');
      expect(r1.error.code).toBe('payload-too-large');
    }

    const r2 = parseLanPairingPayload('{}', 'text/plain');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('unsupported-content-type');

    const r3 = parseLanPairingPayload('{bad json', 'application/json');
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.code).toBe('invalid-json');

    const r4 = parseLanPairingPayload('[]', 'application/json');
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.error.code).toBe('invalid-payload');

    const r5 = parseLanPairingPayload(JSON.stringify({ kind: 'ftp', url: 'https://a.example' }));
    expect(r5.ok).toBe(false);
    if (!r5.ok) expect(r5.error.code).toBe('invalid-kind');
  });

  it('rejects non-http(s) schemes, missing required fields, overlong fields, and never leaks secrets', () => {
    const badSchemes = [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.com/list.m3u',
      'not a url',
      'https://example.com/has space',
    ];
    for (const url of badSchemes) {
      const res = parseLanPairingPayload(JSON.stringify({ kind: 'm3u', url }));
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.category).toBe('source-format');
        expect(JSON.stringify(res.error)).not.toContain(url);
      }
    }

    const badGuide = parseLanPairingPayload(
      JSON.stringify({
        kind: 'm3u',
        url: 'https://example.com/list.m3u',
        guideUrl: 'javascript:alert(1)',
      }),
    );
    expect(badGuide.ok).toBe(false);
    if (!badGuide.ok) expect(badGuide.error.code).toBe('invalid-guide-url');

    const missingCreds = parseLanPairingPayload(
      JSON.stringify({
        kind: 'xtream',
        server: 'https://portal.example',
        username: 'secretuser',
        password: '   ',
      }),
    );
    expect(missingCreds.ok).toBe(false);
    if (!missingCreds.ok) {
      expect(missingCreds.error.code).toBe('missing-password');
      expect(JSON.stringify(missingCreds.error)).not.toContain('secretuser');
    }

    const missingUser = parseLanPairingPayload(
      JSON.stringify({
        kind: 'xtream',
        server: 'https://portal.example',
        username: '',
        password: 'secretpassword',
      }),
    );
    expect(missingUser.ok).toBe(false);
    if (!missingUser.ok) {
      expect(missingUser.error.code).toBe('missing-username');
      expect(JSON.stringify(missingUser.error)).not.toContain('secretpassword');
    }

    const longName = parseLanPairingPayload(
      JSON.stringify({
        kind: 'm3u',
        name: 'x'.repeat(121),
        url: 'https://example.com/list.m3u',
      }),
    );
    expect(longName.ok).toBe(false);
    if (!longName.ok) expect(longName.error.code).toBe('name-too-long');

    const longUrl = parseLanPairingPayload(
      JSON.stringify({
        kind: 'm3u',
        url: `https://example.com/${'a'.repeat(2050)}`,
      }),
    );
    expect(longUrl.ok).toBe(false);
    if (!longUrl.ok) expect(longUrl.error.code).toBe('url-too-long');

    const longPass = parseLanPairingPayload(
      JSON.stringify({
        kind: 'xtream',
        server: 'https://portal.example',
        username: 'alice',
        password: 'p'.repeat(257),
      }),
    );
    expect(longPass.ok).toBe(false);
    if (!longPass.ok) expect(longPass.error.code).toBe('password-too-long');

    const missingM3uUrl = parseLanPairingPayload(JSON.stringify({ kind: 'm3u', name: 'Empty' }));
    expect(missingM3uUrl.ok).toBe(false);
    if (!missingM3uUrl.ok) expect(missingM3uUrl.error.code).toBe('missing-url');

    const missingServer = parseLanPairingPayload(
      JSON.stringify({ kind: 'xtream', username: 'u', password: 'p' }),
    );
    expect(missingServer.ok).toBe(false);
    if (!missingServer.ok) expect(missingServer.error.code).toBe('missing-server');

    const longServer = parseLanPairingPayload(
      JSON.stringify({
        kind: 'xtream',
        server: `https://portal.example/${'s'.repeat(2050)}`,
        username: 'u',
        password: 'p',
      }),
    );
    expect(longServer.ok).toBe(false);
    if (!longServer.ok) expect(longServer.error.code).toBe('server-too-long');

    const badServer = parseLanPairingPayload(
      JSON.stringify({
        kind: 'xtream',
        server: 'ftp://portal.example',
        username: 'u',
        password: 'p',
      }),
    );
    expect(badServer.ok).toBe(false);
    if (!badServer.ok) expect(badServer.error.code).toBe('invalid-server');

    const longUser = parseLanPairingPayload(
      JSON.stringify({
        kind: 'xtream',
        server: 'https://portal.example',
        username: 'u'.repeat(257),
        password: 'p',
      }),
    );
    expect(longUser.ok).toBe(false);
    if (!longUser.ok) expect(longUser.error.code).toBe('username-too-long');

    const longGuide = parseLanPairingPayload(
      JSON.stringify({
        kind: 'm3u',
        url: 'https://example.com/list.m3u',
        guideUrl: `https://example.com/${'g'.repeat(2050)}`,
      }),
    );
    expect(longGuide.ok).toBe(false);
    if (!longGuide.ok) expect(longGuide.error.code).toBe('guide-url-too-long');

    const utf8Oversized = JSON.stringify({
      kind: 'm3u',
      name: '📺'.repeat(4200),
      url: 'https://example.com/list.m3u',
    });
    const utf8Res = parseLanPairingPayload(utf8Oversized);
    expect(utf8Res.ok).toBe(false);
    if (!utf8Res.ok) expect(utf8Res.error.code).toBe('payload-too-large');

    const multiByteOk = parseLanPairingPayload(
      JSON.stringify({
        kind: 'm3u',
        name: 'Türkçe 📺 Kanallar ☃',
        url: 'https://example.com/list.m3u',
      }),
    );
    expect(multiByteOk.ok).toBe(true);
  });
});

describe('renderLanPairingHtml', () => {
  it('renders self-contained English and Turkish forms with zero external requests or crypto.subtle', () => {
    const enHtml = renderLanPairingHtml({ token: VALID_TOKEN });
    expect(enHtml).toContain('<!DOCTYPE html>');
    expect(enHtml).toContain('<html lang="en">');
    expect(enHtml).toContain(`/pair/${VALID_TOKEN}`);
    expect(enHtml).toContain('M3U');
    expect(enHtml).toContain('Xtream');
    expect(enHtml).not.toContain('crypto.subtle');
    expect(enHtml).not.toMatch(/<script[^>]+src=/i);
    expect(enHtml).not.toMatch(/<link[^>]+href=/i);
    expect(enHtml).not.toMatch(/<img[^>]+src=/i);
    expect(enHtml).not.toMatch(/\bdvr\b/i);

    const trHtml = renderLanPairingHtml({ token: VALID_TOKEN, locale: 'tr' });
    expect(trHtml).toContain('<html lang="tr">');
    expect(trHtml).toContain(`/pair/${VALID_TOKEN}`);
    expect(trHtml).not.toContain('crypto.subtle');
    expect(trHtml).not.toMatch(/\bdvr\b/i);
  });

  it('escapes unsafe characters if a non-hex token is passed', () => {
    const html = renderLanPairingHtml({ token: 'abc"><script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
