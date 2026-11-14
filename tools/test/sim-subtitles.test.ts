import { describe, expect, it } from 'vitest';
import { hlsPlaylist, masterPlaylist, parseDurations, vodPlaylist } from '../src/sim/hls.ts';
import { firstVideoPts } from '../src/sim/mpegts.ts';
import { cueText, srtText, vttSegment } from '../src/sim/subtitles.ts';

/**
 * One 188-byte transport packet that starts a PES with a PTS. `adaptation` adds an adaptation field of
 * that many bytes after its length byte.
 */
function pes(pid: number, streamId: number, pts: number, adaptation = -1): Buffer {
  const packet = Buffer.alloc(188, 0xff);
  packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, adaptation < 0 ? 0x10 : 0x30]);
  let at = 4;
  if (adaptation >= 0) {
    packet[4] = adaptation;
    if (adaptation > 0) packet[5] = 0x40;
    at = 5 + adaptation;
  }
  packet.set([0, 0, 1, streamId, 0, 0, 0x80, 0x80, 5], at);
  const high = Math.floor(pts / 2 ** 30);
  const mid = Math.floor(pts / 2 ** 15) % 2 ** 15;
  const low = pts % 2 ** 15;
  packet.set(
    [0x21 | (high << 1), mid >> 7, ((mid & 0x7f) << 1) | 1, low >> 7, ((low & 0x7f) << 1) | 1],
    at + 9,
  );
  return packet;
}

describe('cues', () => {
  it('formats cue text', () => {
    expect(cueText('tur', 12)).toBe('TUR 00:12');
    expect(cueText('eng', 75)).toBe('ENG 01:15');
  });

  it('writes one SRT cue per second', () => {
    expect(srtText('tur', 2)).toBe(
      '1\n00:00:00,000 --> 00:00:01,000\nTUR 00:00\n\n2\n00:00:01,000 --> 00:00:02,000\nTUR 00:01\n',
    );
  });

  it('maps a WebVTT segment to its PTS and stops at the loop end', () => {
    expect(vttSegment('eng', 12, 600, 2293200)).toBe(
      'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:2293200,LOCAL:00:00:24.000\n\n' +
        '00:00:24.000 --> 00:00:25.000\nENG 00:24\n\n00:00:25.000 --> 00:00:26.000\nENG 00:25\n',
    );
    expect(vttSegment('tur', 1, 3, 0)).toBe(
      'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:02.000\n\n' +
        '00:00:02.000 --> 00:00:03.000\nTUR 00:02\n',
    );
  });
});

describe('firstVideoPts', () => {
  it('reads the first video PTS', () => {
    const data = Buffer.concat([pes(0x101, 0xc0, 90_000), pes(0x100, 0xe0, 133_200)]);
    expect(firstVideoPts(data)).toBe(133_200);
    expect(firstVideoPts(pes(0x100, 0xe0, 2 ** 33 - 1))).toBe(2 ** 33 - 1);
    expect(firstVideoPts(pes(0x101, 0xc0, 5))).toBeNull();
  });

  it('skips adaptation fields, foreign sync bytes and video without a PTS', () => {
    const noPts = pes(0x100, 0xe0, 7);
    noPts[11] = 0;
    const lost = Buffer.alloc(188);
    const data = Buffer.concat([lost, noPts, pes(0x100, 0xef, 4_000_000_000, 7)]);
    expect(firstVideoPts(data)).toBe(4_000_000_000);
    expect(firstVideoPts(new Uint8Array(100))).toBeNull();
  });
});

describe('playlists', () => {
  it('writes the master playlist', () => {
    const r = 'h264-2audio-subs-720p25';
    expect(masterPlaylist(r, 'live')).toBe(
      [
        '#EXTM3U',
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="tr",NAME="Turkish",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/${r}/subs/tur/live.m3u8"`,
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/${r}/subs/eng/live.m3u8"`,
        '#EXT-X-STREAM-INF:BANDWIDTH=700000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=25.000,SUBTITLES="subs"',
        `/hls/${r}/live.m3u8`,
        '',
      ].join('\n'),
    );
    expect(masterPlaylist(r, 'vod')).toContain(`/hls/${r}/subs/eng/vod.m3u8`);
    expect(masterPlaylist(r, 'vod')).toContain(`\n/hls/${r}/vod.m3u8\n`);
  });

  it('has no master playlist for a recipe without subtitles', () => {
    expect(() => masterPlaylist('h264-aac-720p25', 'live')).toThrow(/no subtitles/);
  });

  it('writes VOD playlists from FFmpeg durations', () => {
    const index =
      '#EXTM3U\n#EXTINF:2.002000,\nseg00000.ts\n#EXTINF:1.400000,\nseg00001.ts\n#EXT-X-ENDLIST\n';
    expect(parseDurations(index)).toEqual([2.002, 1.4]);
    expect(vodPlaylist([2.002, 1.4], (i) => `/hls/x/${i}.ts`)).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:2',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        '#EXTINF:2.002,',
        '/hls/x/0.ts',
        '#EXTINF:1.400,',
        '/hls/x/1.ts',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    );
  });

  it('raises the VOD target duration to the longest rounded segment', () => {
    expect(vodPlaylist([2, 2.6], (i) => `${i}.ts`)).toContain('#EXT-X-TARGETDURATION:3\n');
  });

  it('builds the live window with another URI', () => {
    const now = Date.UTC(2026, 0, 1) + 61_000;
    const vtt = hlsPlaylist('h264-2audio-subs-720p25', 2, now, (s) => `/v/${s}.vtt`);
    const ts = hlsPlaylist('h264-2audio-subs-720p25', 2, now);
    expect(vtt.replace(/\/v\/(\d+)\.vtt/g, '/hls/h264-2audio-subs-720p25/$1.ts')).toBe(ts);
  });
});
