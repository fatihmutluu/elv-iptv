import { describe, expect, it } from 'vitest';
import { redactUrls } from './redact.ts';

describe('redactUrls', () => {
  it('uses strict allowlist redaction: keeps scheme, host and media extension only', () => {
    expect(redactUrls('http://u:p@h/live/demo/password/1.ts?token=x#f')).toBe(
      'http://h/***/***/***/***.ts',
    );
    expect(redactUrls('Failed to open https://h:80/movie/a/b/9.mkv.')).toBe(
      'Failed to open https://h:80/***/***/***/***.mkv.',
    );
    expect(redactUrls('x https://h/series/a/b/9.mkv?q=1 y')).toBe(
      'x https://h/***/***/***/***.mkv y',
    );
    expect(redactUrls('http://h/timeshift/a/b/60/2026/x.ts')).toBe(
      'http://h/***/***/***/***/***/***.ts',
    );
    expect(redactUrls('http://h:8080/user/password/1001.ts')).toBe('http://h:8080/***/***/***.ts');
    expect(redactUrls('http://h/a/b/c/d.m3u8')).toBe('http://h/***/***/***/***.m3u8');
    expect(redactUrls('http://h/a/b/')).toBe('http://h/***/***/');
  });

  it('masks tokenized path segments without extensions and JWT-like dotted tokens', () => {
    expect(
      redactUrls('https://cdn.example.com/play/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part_here'),
    ).toBe('https://cdn.example.com/***/***');
  });

  it('redacts tcp, tls, rtsp, rtmp and httpproxy URLs', () => {
    expect(redactUrls('Connection to tcp://127.0.0.1:7878 failed')).toBe(
      'Connection to tcp://127.0.0.1:7878 failed',
    );
    expect(redactUrls('tls://u:p@stream.example.com:443/secret/1.ts?auth=9')).toBe(
      'tls://stream.example.com:443/***/***.ts',
    );
    expect(redactUrls('rtsp://admin:secret@cam.local:554/h264Preview_01_main')).toBe(
      'rtsp://cam.local:554/***',
    );
    expect(redactUrls('rtmp://ingest.local/live/secret_stream_key')).toBe(
      'rtmp://ingest.local/***/***',
    );
    expect(redactUrls('httpproxy://proxyuser:proxypass@10.0.0.1:3128/live/1.m3u8')).toBe(
      'httpproxy://10.0.0.1:3128/***/***.m3u8',
    );
  });

  it('masks Authorization, Cookie, Bearer, username, password, token and auth outside URLs', () => {
    expect(redactUrls('get.php?username=user&password=password&type=m3u')).toBe(
      'get.php?username=***&password=***&type=m3u',
    );
    expect(redactUrls('token=abc123&auth=xyz987&mode=live')).toBe('token=***&auth=***&mode=live');
    expect(redactUrls('Authorization: Bearer secret-jwt.token\nCookie: sid=123; a=b')).toBe(
      'Authorization: ***\nCookie: ***',
    );
    expect(redactUrls('sent Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig in header')).toBe(
      'sent Bearer *** in header',
    );
  });

  it('leaves plain text and bare hosts without secrets alone', () => {
    expect(redactUrls('HTTP error 404 Not Found')).toBe('HTTP error 404 Not Found');
    expect(redactUrls('http://h')).toBe('http://h');
    expect(redactUrls('http://h/')).toBe('http://h/');
  });
});
