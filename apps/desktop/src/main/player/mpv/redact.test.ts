import { describe, expect, it } from 'vitest';
import { redactUrls } from './redact.ts';

describe('redactUrls', () => {
  it('drops user-info, query and fragment and masks the password segment', () => {
    expect(redactUrls('http://u:p@h/live/demo/password/1.ts?token=x#f')).toBe(
      'http://h/live/demo/***/1.ts',
    );
  });
  it('masks movie and series paths and leaves surrounding text', () => {
    expect(redactUrls('Failed to open https://h:80/movie/a/b/9.mkv.')).toBe(
      'Failed to open https://h:80/movie/a/***/9.mkv.',
    );
    expect(redactUrls('x https://h/series/a/b/9.mkv?q=1 y')).toBe(
      'x https://h/series/a/***/9.mkv y',
    );
  });
  it('leaves text without urls and non-xtream paths alone', () => {
    expect(redactUrls('HTTP error 404 Not Found')).toBe('HTTP error 404 Not Found');
    expect(redactUrls('http://h/a/b/c.m3u8')).toBe('http://h/a/b/c.m3u8');
  });
});
