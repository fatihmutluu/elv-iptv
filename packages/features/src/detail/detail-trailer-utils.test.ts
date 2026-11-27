import { describe, expect, it } from 'vitest';
import {
  buildYoutubeEmbedUrl,
  buildYoutubeWatchUrl,
  formatCompactVotes,
  isValidTrailerStreamUrl,
  isValidYoutubeId,
  resolveTrailerPlaybackStrategy,
} from './detail-trailer-utils';

describe('detail-trailer-utils (#512)', () => {
  describe('isValidYoutubeId', () => {
    it('accepts strict 11-character YouTube IDs', () => {
      expect(isValidYoutubeId('dQw4w9WgXcQ')).toBe(true);
      expect(isValidYoutubeId('abc_123-XYZ')).toBe(true);
      expect(isValidYoutubeId(' dQw4w9WgXcQ ')).toBe(true);
    });

    it('rejects malformed, short, long, or URL-injected values', () => {
      expect(isValidYoutubeId(null)).toBe(false);
      expect(isValidYoutubeId(undefined)).toBe(false);
      expect(isValidYoutubeId('')).toBe(false);
      expect(isValidYoutubeId('short123')).toBe(false);
      expect(isValidYoutubeId('toolong12345')).toBe(false);
      expect(isValidYoutubeId('dQw4w9WgXc?')).toBe(false);
      expect(isValidYoutubeId('https://youtu.be/dQw4w9WgXcQ')).toBe(false);
    });
  });

  describe('isValidTrailerStreamUrl', () => {
    it('accepts clean public https direct stream URLs', () => {
      expect(isValidTrailerStreamUrl('https://imdb-video.media-imdb.com/vi123/trailer.mp4')).toBe(
        true,
      );
      expect(isValidTrailerStreamUrl('https://cdn.example.com/hls/trailer.m3u8')).toBe(true);
      expect(isValidTrailerStreamUrl('https://93.184.216.34/trailer.mp4')).toBe(true);
      expect(isValidTrailerStreamUrl('https://[2606:2800:220:1:248:1893:25c8:1946]/t.mp4')).toBe(
        true,
      );
    });

    it('rejects non-https, javascript, file, or credential-bearing URLs', () => {
      expect(isValidTrailerStreamUrl(null)).toBe(false);
      expect(isValidTrailerStreamUrl(undefined)).toBe(false);
      expect(isValidTrailerStreamUrl('')).toBe(false);
      expect(isValidTrailerStreamUrl('http://insecure.example.com/a.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('javascript:alert(1)')).toBe(false);
      expect(isValidTrailerStreamUrl('file:///etc/passwd')).toBe(false);
      expect(isValidTrailerStreamUrl('https://user:pass@cdn.example.com/a.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://user@cdn.example.com/a.mp4')).toBe(false);
    });

    it('rejects ASCII control characters and whitespace in raw URLs', () => {
      expect(isValidTrailerStreamUrl(' https://cdn.example.com/a.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://cdn.example.com/a.mp4 ')).toBe(false);
      expect(isValidTrailerStreamUrl('https://cdn.example.com/a b.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://cdn.example.com/a\r\n.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://cdn.example.com/a\u0000.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://cdn.example.com/a\u001f.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://cdn.example.com/a\u007f.mp4')).toBe(false);
    });

    it('rejects localhost, *.localhost, *.local, and *.internal hosts (SSRF guard)', () => {
      expect(isValidTrailerStreamUrl('https://localhost/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://localhost./trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://api.localhost/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://printer.local/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://metadata.google.internal/trailer.mp4')).toBe(false);
    });

    it('rejects loopback, unspecified, link-local, CGNAT, and RFC-1918 IPv4 including integer/hex/octal forms', () => {
      expect(isValidTrailerStreamUrl('https://127.0.0.1/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://127.255.0.1:8443/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://0.0.0.0/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://0.1.2.3/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://10.0.0.1/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://172.16.0.1/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://172.31.255.254/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://192.168.1.1/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
      expect(isValidTrailerStreamUrl('https://100.64.0.1/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://100.127.255.254/trailer.mp4')).toBe(false);
      // Integer, hex, octal, and shorthand IPv4 encodings
      expect(isValidTrailerStreamUrl('https://2130706433/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://0x7f000001/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://0177.0.0.1/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://127.1/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://0xa9fea9fe/trailer.mp4')).toBe(false);
    });

    it('rejects loopback, unspecified, link-local, ULA, and IPv4-mapped IPv6 addresses', () => {
      expect(isValidTrailerStreamUrl('https://[::]/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://[::1]/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://[0:0:0:0:0:0:0:1]/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://[fe80::1]/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://[febf::1]/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://[fc00::1]/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://[fd12:3456:789a::1]/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://[::ffff:127.0.0.1]/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://[::ffff:192.168.1.1]/trailer.mp4')).toBe(false);
      expect(isValidTrailerStreamUrl('https://[::ffff:93.184.216.34]/trailer.mp4')).toBe(false);
    });
  });

  describe('YouTube URL builders', () => {
    it('builds strict watch and nocookie embed URLs', () => {
      expect(buildYoutubeWatchUrl('dQw4w9WgXcQ')).toBe(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      );
      expect(buildYoutubeEmbedUrl('dQw4w9WgXcQ')).toBe(
        'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0',
      );
      expect(buildYoutubeWatchUrl('invalid!')).toBeNull();
      expect(buildYoutubeEmbedUrl('invalid!')).toBeNull();
    });
  });

  describe('resolveTrailerPlaybackStrategy', () => {
    it('prioritizes direct IMDb MP4/HLS stream when valid and videoHost is available', () => {
      expect(
        resolveTrailerPlaybackStrategy({
          trailerStreamUrl: 'https://imdb-video.media-imdb.com/vi123/trailer.mp4',
          trailerYoutubeId: 'dQw4w9WgXcQ',
          formFactor: 'tv',
          platformOs: 'android',
          hasVideoHost: true,
        }),
      ).toEqual({
        kind: 'native-stream',
        url: 'https://imdb-video.media-imdb.com/vi123/trailer.mp4',
      });
    });

    it('hands off YouTube watch URL externally on 10-ft TV', () => {
      expect(
        resolveTrailerPlaybackStrategy({
          trailerStreamUrl: null,
          trailerYoutubeId: 'dQw4w9WgXcQ',
          formFactor: 'tv',
          platformOs: 'android',
          hasVideoHost: true,
        }),
      ).toEqual({
        kind: 'external-youtube',
        youtubeId: 'dQw4w9WgXcQ',
        watchUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      });
    });

    it('uses sandboxed youtube-nocookie iframe on Desktop/Web', () => {
      expect(
        resolveTrailerPlaybackStrategy({
          trailerStreamUrl: null,
          trailerYoutubeId: 'dQw4w9WgXcQ',
          formFactor: 'desktop',
          platformOs: 'web',
          hasVideoHost: true,
        }),
      ).toEqual({
        kind: 'web-iframe',
        youtubeId: 'dQw4w9WgXcQ',
        embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0',
        watchUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      });
    });

    it('uses mobile-external fallback on native phone/tablet when only YouTube ID exists', () => {
      expect(
        resolveTrailerPlaybackStrategy({
          trailerStreamUrl: null,
          trailerYoutubeId: 'dQw4w9WgXcQ',
          formFactor: 'phone',
          platformOs: 'ios',
          hasVideoHost: true,
        }),
      ).toEqual({
        kind: 'mobile-external',
        youtubeId: 'dQw4w9WgXcQ',
        watchUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      });
    });

    it('returns unavailable when neither valid stream nor valid YouTube ID exists', () => {
      expect(
        resolveTrailerPlaybackStrategy({
          trailerStreamUrl: 'javascript:alert(1)',
          trailerYoutubeId: 'bad',
          formFactor: 'desktop',
          platformOs: 'web',
          hasVideoHost: true,
        }),
      ).toEqual({ kind: 'unavailable' });
    });
  });

  describe('formatCompactVotes', () => {
    it('formats vote counts concisely', () => {
      expect(formatCompactVotes(850)).toBe('850');
      expect(formatCompactVotes(12_500)).toBe('12.5K');
      expect(formatCompactVotes(2_500_000)).toBe('2.5M');
      expect(formatCompactVotes(1_000_000)).toBe('1M');
      expect(formatCompactVotes(0)).toBeNull();
      expect(formatCompactVotes(null)).toBeNull();
    });
  });
});
