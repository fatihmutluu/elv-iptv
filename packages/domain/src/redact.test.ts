import { describe, expect, it } from 'vitest';
import { CREDENTIAL_PARAMS, redactText, redactUrl } from './index';

describe('redactUrl', () => {
  it('redacts userinfo, Xtream path credentials, and query/fragment while keeping scheme, host, and media extension', () => {
    expect(redactUrl('http://demo:pass@sim.test/live/demo/pass/1001.ts?token=abc#frag')).toBe(
      'http://sim.test/***/***/***/***.ts',
    );
    expect(redactUrl('https://demo:p@ss@sim.test:8443/movie/demo/pass/42.mkv?sig=1&e=99')).toBe(
      'https://sim.test:8443/***/***/***/***.mkv',
    );
    expect(
      redactUrl('https://sim.test/series/demo/pass/9.mp4?expires=1700000&st=tok&hash=ff'),
    ).toBe('https://sim.test/***/***/***/***.mp4');
    expect(redactUrl('http://sim.test/timeshift/demo/pass/60/2026-01-01:10-00/1001.ts')).toBe(
      'http://sim.test/***/***/***/***/***/***.ts',
    );
    expect(redactUrl('http://sim.test/a/b/')).toBe('http://sim.test/***/***/');
    expect(redactUrl('http://sim.test')).toBe('http://sim.test');
    expect(redactUrl('http://sim.test/')).toBe('http://sim.test/');
  });

  it('redacts file:// URLs completely to file://<redacted>', () => {
    expect(redactUrl('file:///Users/alice/playlists/private.m3u')).toBe('file://<redacted>');
    expect(redactUrl('FILE://localhost/C:/Users/alice/catalog.db')).toBe('file://<redacted>');
    expect(redactUrl('file:/etc/passwd')).toBe('file://<redacted>');
  });

  it('redacts udp, rtp, ftp, rtsp(s), rtmp(s), tcp, tls, and httpproxy URLs', () => {
    expect(redactUrl('udp://239.0.0.1:1234/secret/stream?token=x')).toBe(
      'udp://239.0.0.1:1234/***/***',
    );
    expect(redactUrl('udp://@239.0.0.1:1234')).toBe('udp://239.0.0.1:1234');
    expect(redactUrl('rtp://239.0.0.2:5004/live/1.ts')).toBe('rtp://239.0.0.2:5004/***/***.ts');
    expect(redactUrl('ftp://demo:pass@files.example/private/list.m3u')).toBe(
      'ftp://files.example/***/***.m3u',
    );
    expect(redactUrl('rtsp://demo:pass@cam.example:554/stream_main')).toBe(
      'rtsp://cam.example:554/***',
    );
    expect(redactUrl('rtsps://demo:pass@cam.example:322/live/1.ts')).toBe(
      'rtsps://cam.example:322/***/***.ts',
    );
    expect(redactUrl('rtmp://ingest.example/live/secret_key')).toBe(
      'rtmp://ingest.example/***/***',
    );
    expect(redactUrl('rtmps://ingest.example/live/secret_key')).toBe(
      'rtmps://ingest.example/***/***',
    );
    expect(redactUrl('tcp://127.0.0.1:7878')).toBe('tcp://127.0.0.1:7878');
    expect(redactUrl('tls://demo:pass@stream.example:443/secret/1.ts?auth=9')).toBe(
      'tls://stream.example:443/***/***.ts',
    );
    expect(redactUrl('httpproxy://demo:pass@proxy.example:3128/live/1.m3u8')).toBe(
      'httpproxy://proxy.example:3128/***/***.m3u8',
    );
  });

  it('handles empty strings, dotted JWT tokens, and non-URL relative strings safely', () => {
    expect(redactUrl('')).toBe('');
    expect(
      redactUrl('https://cdn.example/play/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part'),
    ).toBe('https://cdn.example/***/***');
    expect(redactUrl('/live/demo/pass/1001.ts?token=abc')).toBe('/***/***/***/***.ts');
    expect(redactUrl('get.php?username=demo&password=pass&type=m3u')).toBe(
      'get.php?username=***&password=***&type=m3u',
    );
  });

  it('trims leading whitespace and masks backslash-separated URL paths without leaking credentials', () => {
    expect(redactUrl(' http://demo:pass@sim.test/live/demo/pass/1.ts')).toBe(
      'http://sim.test/***/***/***/***.ts',
    );
    expect(redactUrl('  file:///Users/alice/catalog.db  ')).toBe('file://<redacted>');
    expect(redactUrl('http://demo:pass@sim.test\\live\\demo\\pass\\1.ts')).toBe(
      'http://sim.test/***/***/***/***.ts',
    );
  });
});

describe('redactText', () => {
  it('redacts embedded URLs across all supported schemes while preserving trailing sentence punctuation', () => {
    expect(redactText('Failed to open https://sim.test:80/movie/demo/pass/9.mkv.')).toBe(
      'Failed to open https://sim.test:80/***/***/***/***.mkv.',
    );
    expect(redactText('Could not read file:///Users/alice/secret.m3u; retrying')).toBe(
      'Could not read file://<redacted>; retrying',
    );
    expect(redactText('cannot open file:/Users/alice/catalog.db')).toBe(
      'cannot open file://<redacted>',
    );
    expect(redactText('Multicast udp://239.0.0.1:1234/chan?token=abc failed)')).toBe(
      'Multicast udp://239.0.0.1:1234/*** failed)',
    );
    expect(redactText('Opened rtp://239.0.0.2:5004/a/b.ts and ftp://u:p@ftp.example/x.m3u8.')).toBe(
      'Opened rtp://239.0.0.2:5004/***/***.ts and ftp://ftp.example/***.m3u8.',
    );
  });

  it('redacts all sensitive headers including Authorization, Proxy-Authorization, Cookie, Set-Cookie, X-Api-Key, and X-Auth-Token', () => {
    const raw = [
      'Authorization: Bearer secret-jwt.token',
      'Proxy-Authorization: Basic dXNlcjpwYXNz',
      'Cookie: sid=abc; theme=dark',
      'Set-Cookie: session=xyz; HttpOnly',
      'X-Api-Key: key-12345',
      'x-auth-token: tok-67890',
      'User-Agent: ELV/1.0',
    ].join('\n');
    expect(redactText(raw)).toBe(
      [
        'Authorization: ***',
        'Proxy-Authorization: ***',
        'Cookie: ***',
        'Set-Cookie: ***',
        'X-Api-Key: ***',
        'x-auth-token: ***',
        'User-Agent: ELV/1.0',
      ].join('\n'),
    );
  });

  it('redacts Bearer/Basic tokens and every CREDENTIAL_PARAMS query parameter outside URLs', () => {
    expect(redactText('sent Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig and Basic dXNlcjpwYXNz')).toBe(
      'sent Bearer *** and Basic ***',
    );
    for (const param of CREDENTIAL_PARAMS) {
      expect(redactText(`get.php?${param}=secretValue123&type=m3u`)).toBe(
        `get.php?${param}=***&type=m3u`,
      );
    }
    expect(
      redactText(
        'api_key=k1&apikey=k2&access_token=t1&expires=1700000&e=12345&st=abc&hash=deadbeef&mode=live',
      ),
    ).toBe('api_key=***&apikey=***&access_token=***&expires=***&e=***&st=***&hash=***&mode=live');
  });

  it('leaves plain text without URLs or secrets unchanged', () => {
    expect(redactText('HTTP error 404 Not Found')).toBe('HTTP error 404 Not Found');
    expect(redactText('type=m3u&mode=live&channel=42')).toBe('type=m3u&mode=live&channel=42');
  });
});
