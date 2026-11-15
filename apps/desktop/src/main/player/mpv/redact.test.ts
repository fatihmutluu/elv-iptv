import { describe, expect, it } from 'vitest';
import { redactUrls } from './redact.ts';

describe('redactUrls', () => {
  it('drops user-info, query and fragment and masks both Xtream segments', () => {
    expect(redactUrls('http://u:p@h/live/demo/password/1.ts?token=x#f')).toBe(
      'http://h/live/***/***/1.ts',
    );
  });
  it('masks movie, series and timeshift paths and leaves surrounding text', () => {
    expect(redactUrls('Failed to open https://h:80/movie/a/b/9.mkv.')).toBe(
      'Failed to open https://h:80/movie/***/***/9.mkv.',
    );
    expect(redactUrls('x https://h/series/a/b/9.mkv?q=1 y')).toBe(
      'x https://h/series/***/***/9.mkv y',
    );
    expect(redactUrls('http://h/timeshift/a/b/60/2026/x.ts')).toBe(
      'http://h/timeshift/***/***/60/2026/x.ts',
    );
  });
  it('masks the short user/pass/id form', () => {
    expect(redactUrls('http://h:8080/user/password/1001.ts')).toBe('http://h:8080/***/***/1001.ts');
  });
  it('masks username and password pairs outside a url', () => {
    expect(redactUrls('get.php?username=user&password=password&type=m3u')).toBe(
      'get.php?username=***&password=***&type=m3u',
    );
  });
  it('leaves text without credentials alone', () => {
    expect(redactUrls('HTTP error 404 Not Found')).toBe('HTTP error 404 Not Found');
    expect(redactUrls('http://h')).toBe('http://h');
    expect(redactUrls('http://h/a/b/c/d.m3u8')).toBe('http://h/a/b/c/d.m3u8');
    expect(redactUrls('http://h/a/b/')).toBe('http://h/a/b/');
  });
});
