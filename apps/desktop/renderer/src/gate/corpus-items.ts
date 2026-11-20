import type { MediaKind } from '@elv/playback';

/** One item in the 29-item desktop format corpus sweep. */
export interface DesktopCorpusItem {
  id: string;
  label: string;
  kind: MediaKind;
  url: string;
  expect: 'playing' | 'failed';
  /** `category/code` the item must fail with when `expect` is `'failed'`. */
  expectError?: string;
  audioOnly?: boolean;
  selectAudioLang?: string;
  selectSubtitleLang?: string;
  seekMs?: number;
}

const LIVE_ENTRIES: readonly (readonly [number, string, string | null, boolean])[] = [
  [1001, 'H.264 720p25 AAC', null, false],
  [1002, 'HEVC 1080p25 8-bit', null, false],
  [1003, 'HEVC 1080p25 10-bit', null, false],
  [1004, 'MPEG-2 576i25 AC-3', null, false],
  [1005, 'H.264 576p25 MP2', null, false],
  [1006, 'AAC radio', null, false],
  [1007, 'H.264 1080i25', null, false],
  [1008, 'H.264 720p50 E-AC-3 5.1', null, false],
  [1009, 'H.264 720p29.97 MP3', null, false],
  [1010, 'Two audio tracks and subtitles', null, true],
  [1011, 'Resolution switch 720p and 1080p', null, false],
  [1012, 'Stream labelled as a web page', 'type=text/html', false],
  [1013, 'Redirect to HLS', 'redirect=hls', false],
  [1014, 'Stream labelled as a playlist', 'type=application/vnd.apple.mpegurl', false],
];

const VOD_ENTRIES: readonly (readonly [number, string, 'mp4' | 'mkv', boolean])[] = [
  [200001, 'H.264 720p25 AAC (MP4)', 'mp4', false],
  [200002, 'HEVC 1080p25 8-bit (MKV)', 'mkv', false],
  [200003, 'HEVC 1080p25 10-bit (MP4)', 'mp4', false],
  [200004, 'MPEG-2 576i25 AC-3 (MKV)', 'mkv', false],
  [200005, 'H.264 576p25 MP2 (MKV)', 'mkv', false],
  [200006, 'AAC radio (MP4)', 'mp4', false],
  [200007, 'H.264 1080i25 (MKV)', 'mkv', false],
  [200008, 'H.264 720p50 E-AC-3 5.1 (MP4)', 'mp4', false],
  [200009, 'H.264 720p29.97 MP3 (MP4)', 'mp4', false],
  [200010, 'Two audio tracks and subtitles (MP4)', 'mp4', true],
  [200011, 'Two audio tracks and subtitles (MKV)', 'mkv', true],
  [200012, 'Resolution switch 720p and 1080p (MKV)', 'mkv', false],
];

/** Builds the 29-item format corpus manifest for the desktop gate driver. */
export function buildDesktopCorpusItems(opts: {
  base: string;
  account: string;
  burst?: number;
}): DesktopCorpusItem[] {
  const { base, account, burst = 0 } = opts;
  const pair = `${account}/${account}`;
  const items: DesktopCorpusItem[] = [];

  for (const [id, label, fault, tracks] of LIVE_ENTRIES) {
    if (fault === 'redirect=hls') {
      items.push({
        id: `live-${id}`,
        label,
        kind: 'live',
        url: `${base}/${pair}/${id}`,
        expect: 'playing',
      });
      continue;
    }
    const queryParts = [
      fault !== null && burst > 0 ? fault : undefined,
      burst > 0 ? `burst=${burst}` : undefined,
    ].filter((part): part is string => part !== undefined);
    const suffix = queryParts.length === 0 ? '' : `?fault=${queryParts.join(',')}`;
    items.push({
      id: `live-${id}`,
      label,
      kind: 'live',
      url: `${base}/live/${pair}/${id}.ts${suffix}`,
      expect: 'playing',
      ...(id === 1006 ? { audioOnly: true } : {}),
      ...(tracks ? { selectAudioLang: 'eng', selectSubtitleLang: 'tur' } : {}),
    });
  }

  items.push({
    id: 'live-1010-hls',
    label: 'Two audio tracks and subtitles (Live HLS WebVTT)',
    kind: 'live',
    url: `${base}/live/${pair}/1010.m3u8`,
    expect: 'playing',
    selectSubtitleLang: 'tur',
  });

  for (const [id, label, ext, tracks] of VOD_ENTRIES) {
    items.push({
      id: `vod-${id}`,
      label,
      kind: 'vod',
      url: `${base}/movie/${pair}/${id}.${ext}`,
      expect: 'playing',
      ...(id === 200006 ? { audioOnly: true } : {}),
      ...(tracks ? { selectAudioLang: 'eng', selectSubtitleLang: 'tur' } : {}),
    });
  }

  items.push({
    id: 'vod-200010-hls',
    label: 'Two audio tracks and subtitles (VOD HLS WebVTT)',
    kind: 'vod',
    url: `${base}/movie/${pair}/200010.m3u8`,
    expect: 'playing',
    selectSubtitleLang: 'tur',
    seekMs: 30_000,
  });

  items.push({
    id: 'vod-200001-empty',
    label: 'Empty 200 VOD response',
    kind: 'vod',
    url: `${base}/movie/${pair}/200001.mp4?fault=empty`,
    expect: 'failed',
    expectError: 'playback/network',
  });

  return items;
}
