import { describe, expect, it } from 'vitest';
import { noopPlaybackGuard } from '../ports/playback-guard';
import {
  createInitialSourceForm,
  detectPastedXtreamLink,
  type SourceFormState,
  validateSourceForm,
} from './validate';

function xtreamForm(overrides: Partial<SourceFormState> = {}): SourceFormState {
  return {
    ...createInitialSourceForm(),
    mode: 'xtream',
    server: 'http://panel.example.test:8080',
    username: 'user',
    password: 'pass',
    ...overrides,
  };
}

function m3uForm(overrides: Partial<SourceFormState> = {}): SourceFormState {
  return {
    ...createInitialSourceForm(),
    mode: 'm3u',
    playlistUrl: 'http://panel.example.test:8080/playlist.m3u8',
    ...overrides,
  };
}

function stalkerForm(overrides: Partial<SourceFormState> = {}): SourceFormState {
  return {
    ...createInitialSourceForm(),
    mode: 'stalker',
    portalUrl: 'http://portal.example.test:8080/c/',
    macAddress: '00:1a:79:00:00:01',
    ...overrides,
  };
}

describe('validateSourceForm and detectPastedXtreamLink', () => {
  it('exposes a no-op default PlaybackGuard', () => {
    expect(noopPlaybackGuard.stopIfUsingSource('s1')).toBeUndefined();
  });

  it('rejects missing scheme, unsupported scheme, invalid ports/hosts, and control characters', () => {
    const noScheme = validateSourceForm(xtreamForm({ server: 'panel.example.test:8080' }));
    expect(noScheme).toEqual({
      ok: false,
      error: {
        code: 'missing-scheme',
        messageId: 'source.validation.missingScheme',
        hintId: 'source.hint.missingScheme',
      },
    });

    const ftp = validateSourceForm(xtreamForm({ server: 'ftp://panel.example.test' }));
    expect(ftp.ok).toBe(false);
    if (!ftp.ok) expect(ftp.error.code).toBe('unsupported-scheme');

    const mailto = validateSourceForm(m3uForm({ playlistUrl: 'mailto:ops@example.test' }));
    expect(mailto.ok).toBe(false);
    if (!mailto.ok) expect(mailto.error.code).toBe('unsupported-scheme');

    for (const bad of ['http://', 'http://host:99999', 'http://host:0', 'http://host:abc']) {
      const res = validateSourceForm(xtreamForm({ server: bad }));
      expect(res.ok, `expected ${bad} to fail`).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('invalid-address');
    }

    const ctrl = validateSourceForm(xtreamForm({ userAgent: 'Bad\r\nHeader' }));
    expect(ctrl.ok).toBe(false);
    if (!ctrl.ok) expect(ctrl.error.code).toBe('invalid-characters');
  });

  it('rejects empty server/credentials in Xtream mode and empty URL in M3U mode', () => {
    const emptyServer = validateSourceForm(xtreamForm({ server: '   ' }));
    expect(emptyServer.ok).toBe(false);
    if (!emptyServer.ok) expect(emptyServer.error.code).toBe('missing-server');

    const emptyCreds = validateSourceForm(xtreamForm({ password: '  ' }));
    expect(emptyCreds.ok).toBe(false);
    if (!emptyCreds.ok) expect(emptyCreds.error.code).toBe('missing-credentials');

    const emptyUrl = validateSourceForm(m3uForm({ playlistUrl: '' }));
    expect(emptyUrl.ok).toBe(false);
    if (!emptyUrl.ok) expect(emptyUrl.error.code).toBe('missing-url');
  });

  it('rejects plain .m3u/.m3u8 URLs pasted into Xtream server', () => {
    const m3uInXtream = validateSourceForm(
      xtreamForm({ server: 'http://panel.example.test:8080/live/playlist.m3u8' }),
    );
    expect(m3uInXtream).toEqual({
      ok: false,
      error: {
        code: 'm3u-in-xtream',
        messageId: 'source.validation.m3uInXtream',
        hintId: 'source.hint.m3uInXtream',
      },
    });
  });

  it('extracts server, credentials, and format when a get.php link is pasted into Xtream server', () => {
    const res = validateSourceForm(
      xtreamForm({
        name: '  ',
        server: '  http://panel.example.test:8080/get.php?username=demo&password=pass&output=ts  ',
        username: '',
        password: '',
      }),
    );
    expect(res).toEqual({
      ok: true,
      value: {
        kind: 'xtream',
        input: {
          kind: 'xtream',
          name: 'panel.example.test:8080',
          server: 'http://panel.example.test:8080',
          username: 'demo',
          password: 'pass',
          transport: { xtreamFormat: 'ts' },
        },
      },
    });
  });

  it('normalizes Xtream server paths, optional guideUrl, and transport settings', () => {
    const badGuide = validateSourceForm(xtreamForm({ guideUrl: 'panel.example.test/epg.xml' }));
    expect(badGuide.ok).toBe(false);
    if (!badGuide.ok) expect(badGuide.error.code).toBe('invalid-guide-url');

    const badReferer = validateSourceForm(xtreamForm({ referer: 'not-a-url' }));
    expect(badReferer.ok).toBe(false);
    if (!badReferer.ok) expect(badReferer.error.code).toBe('missing-scheme');

    const okRes = validateSourceForm(
      xtreamForm({
        name: 'Home Panel',
        server: ' https://panel.example.test:8443/player_api.php/ ',
        xtreamFormat: 'm3u8',
        guideUrl: ' https://panel.example.test:8443/epg.xml.gz ',
        userAgent: ' CustomPlayer/1.0 ',
        referer: ' https://panel.example.test/ ',
      }),
    );
    expect(okRes).toEqual({
      ok: true,
      value: {
        kind: 'xtream',
        input: {
          kind: 'xtream',
          name: 'Home Panel',
          server: 'https://panel.example.test:8443',
          username: 'user',
          password: 'pass',
          guideUrl: 'https://panel.example.test:8443/epg.xml.gz',
          transport: {
            xtreamFormat: 'm3u8',
            userAgent: 'CustomPlayer/1.0',
            referer: 'https://panel.example.test/',
          },
        },
      },
    });
  });

  it('detects get.php links in M3U mode and honors keepAsM3u', () => {
    const getPhp = 'http://panel.example.test:8080/get.php?username=demo&password=pass&output=m3u8';
    expect(detectPastedXtreamLink(getPhp)).toBe(true);
    expect(detectPastedXtreamLink('http://panel.example.test/playlist.m3u')).toBe(false);
    expect(detectPastedXtreamLink(`${getPhp}\n`)).toBe(false);

    const converted = validateSourceForm(m3uForm({ playlistUrl: getPhp, keepAsM3u: false }));
    expect(converted).toEqual({
      ok: true,
      value: {
        kind: 'link',
        detectedXtream: true,
        input: {
          name: 'panel.example.test:8080',
          url: getPhp,
        },
      },
    });

    const kept = validateSourceForm(m3uForm({ playlistUrl: getPhp, keepAsM3u: true }));
    expect(kept).toEqual({
      ok: true,
      value: {
        kind: 'link',
        detectedXtream: false,
        input: {
          name: 'panel.example.test:8080',
          url: getPhp,
          keepAsM3u: true,
        },
      },
    });
  });

  it('uses caller-supplied localized fallback name when local M3U filename stem is blank (#51)', () => {
    const res = validateSourceForm(
      m3uForm({
        name: '   ',
        localFile: {
          name: '.m3u8',
          bytes: new Uint8Array([1, 2, 3]),
        },
      }),
      { defaultLocalPlaylistName: 'Yerel dosya' },
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.value.kind === 'local-m3u') {
      expect(res.value.input.name).toBe('Yerel dosya');
    }
  });

  it('attaches dnsFamily and validated hostOverride to transport and rejects invalid hostOverride (#172)', () => {
    const systemOnly = validateSourceForm(xtreamForm({ dnsFamily: 'system', hostOverride: '  ' }));
    expect(systemOnly.ok).toBe(true);
    if (systemOnly.ok && systemOnly.value.kind === 'xtream') {
      expect(systemOnly.value.input.transport).toBeUndefined();
    }

    const ipv4Res = validateSourceForm(
      xtreamForm({ dnsFamily: 'ipv4', hostOverride: ' 203.0.113.10 ' }),
    );
    expect(ipv4Res.ok).toBe(true);
    if (ipv4Res.ok && ipv4Res.value.kind === 'xtream') {
      expect(ipv4Res.value.input.transport).toEqual({
        dnsFamily: 'ipv4',
        hostOverride: '203.0.113.10',
      });
    }

    const ipv6Res = validateSourceForm(
      m3uForm({ dnsFamily: 'ipv6', hostOverride: '[2001:DB8::1]' }),
    );
    expect(ipv6Res.ok).toBe(true);
    if (ipv6Res.ok && ipv6Res.value.kind === 'link') {
      expect(ipv6Res.value.input.transport).toEqual({
        dnsFamily: 'ipv6',
        hostOverride: '2001:db8::1',
      });
    }

    for (const bad of [
      'panel.example.test',
      '203.0.113.10:8080',
      'http://203.0.113.10',
      '999.1.1.1',
    ]) {
      const invalid = validateSourceForm(xtreamForm({ hostOverride: bad }));
      expect(invalid, `expected ${bad} to fail`).toEqual({
        ok: false,
        error: {
          code: 'invalid-host-override',
          messageId: 'sources.network.invalidHostOverride',
          hintId: 'sources.network.hostOverrideHint',
        },
      });
    }
  });

  it('parses newline-separated Xtream backupServers and rejects invalid backup URLs (#317)', () => {
    const okRes = validateSourceForm(
      xtreamForm({
        backupServers: [
          '  http://mirror1.example.test:8080/player_api.php  ',
          '',
          'https://mirror2.example.test:8443/',
          'http://mirror1.example.test:8080',
        ].join('\n'),
      }),
    );
    expect(okRes.ok).toBe(true);
    if (okRes.ok && okRes.value.kind === 'xtream') {
      expect(okRes.value.input.backupServers).toEqual([
        'http://mirror1.example.test:8080',
        'https://mirror2.example.test:8443',
      ]);
    }

    const badScheme = validateSourceForm(
      xtreamForm({ backupServers: 'ftp://mirror.example.test' }),
    );
    expect(badScheme.ok).toBe(false);
    if (!badScheme.ok) expect(badScheme.error.code).toBe('unsupported-scheme');

    const badCtrl = validateSourceForm(
      xtreamForm({ backupServers: 'http://mirror.example.test\u0000' }),
    );
    expect(badCtrl.ok).toBe(false);
    if (!badCtrl.ok) expect(badCtrl.error.code).toBe('invalid-characters');
  });

  it('validates Stalker portalUrl, MAC addresses (: and -), serialNumber, and transport (#29)', () => {
    const colonRes = validateSourceForm(
      stalkerForm({
        name: 'Living Room Portal',
        portalUrl: '  http://portal.example.test:8080/c/  ',
        macAddress: ' 00:1a:79:00:00:01 ',
        serialNumber: ' SN-00123 ',
        guideUrl: ' https://portal.example.test/epg.xml ',
        xmltvTimezone: 'Europe/Istanbul',
        userAgent: ' CustomSTB/1.0 ',
        referer: ' https://portal.example.test/ ',
        allowLegacyTls: true,
        dnsFamily: 'ipv4',
        hostOverride: '203.0.113.20',
      }),
    );
    expect(colonRes).toEqual({
      ok: true,
      value: {
        kind: 'stalker',
        input: {
          kind: 'stalker',
          name: 'Living Room Portal',
          portalUrl: 'http://portal.example.test:8080/c/',
          mac: '00:1A:79:00:00:01',
          serialNumber: 'SN-00123',
          guideUrl: 'https://portal.example.test/epg.xml',
          xmltvTimezone: 'Europe/Istanbul',
          transport: {
            userAgent: 'CustomSTB/1.0',
            referer: 'https://portal.example.test/',
            allowLegacyTls: true,
            dnsFamily: 'ipv4',
            hostOverride: '203.0.113.20',
          },
        },
      },
    });

    const dashHostPortRes = validateSourceForm(
      stalkerForm({
        name: '   ',
        portalUrl: 'portal.example.test:8080/c/',
        macAddress: '00-1a-79-aa-bb-cc',
        serialNumber: '   ',
      }),
    );
    expect(dashHostPortRes).toEqual({
      ok: true,
      value: {
        kind: 'stalker',
        input: {
          kind: 'stalker',
          name: 'portal.example.test:8080',
          portalUrl: 'http://portal.example.test:8080/c/',
          mac: '00:1A:79:AA:BB:CC',
        },
      },
    });
  });

  it('rejects invalid Stalker portal URLs, invalid MACs, and control characters (#29)', () => {
    const emptyPortal = validateSourceForm(stalkerForm({ portalUrl: '   ' }));
    expect(emptyPortal.ok).toBe(false);
    if (!emptyPortal.ok) expect(emptyPortal.error.code).toBe('missing-server');

    const badScheme = validateSourceForm(
      stalkerForm({ portalUrl: 'ftp://portal.example.test/c/' }),
    );
    expect(badScheme.ok).toBe(false);
    if (!badScheme.ok) expect(badScheme.error.code).toBe('unsupported-scheme');

    const badInlineScheme = validateSourceForm(stalkerForm({ portalUrl: 'javascript:alert(1)' }));
    expect(badInlineScheme.ok).toBe(false);
    if (!badInlineScheme.ok) expect(badInlineScheme.error.code).toBe('unsupported-scheme');

    for (const badMac of ['', '00:1A:79:00:00', 'ZZ:1A:79:00:00:01', '00:1A-79:00:00:01']) {
      const res = validateSourceForm(stalkerForm({ macAddress: badMac }));
      expect(res, `expected ${badMac} to fail`).toEqual({
        ok: false,
        error: {
          code: 'invalid-mac',
          messageId: 'sources.stalker.invalidMac',
          hintId: 'sources.stalker.invalidMacHint',
        },
      });
    }

    const badSerial = validateSourceForm(stalkerForm({ serialNumber: 'SN\n123' }));
    expect(badSerial.ok).toBe(false);
    if (!badSerial.ok) expect(badSerial.error.code).toBe('invalid-characters');

    for (const credsPortal of [
      'https://user:pass@portal.example.test/c/',
      'http://user@portal.example.test:8080/c/',
      'user@portal.example.test/c/',
    ]) {
      const res = validateSourceForm(stalkerForm({ portalUrl: credsPortal }));
      expect(res.ok, `expected ${credsPortal} to fail`).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('invalid-address');
    }

    const oversizedSerial = validateSourceForm(stalkerForm({ serialNumber: 'S'.repeat(129) }));
    expect(oversizedSerial.ok).toBe(false);
    if (!oversizedSerial.ok) expect(oversizedSerial.error.code).toBe('invalid-characters');

    const maxSerial = validateSourceForm(stalkerForm({ serialNumber: 'S'.repeat(128) }));
    expect(maxSerial.ok).toBe(true);
  });
});
