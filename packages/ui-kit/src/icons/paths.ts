/** Canonical vector icon identifiers available across `@elv/ui-kit`. */
export type IconName =
  | 'home'
  | 'tv'
  | 'film'
  | 'series'
  | 'search'
  | 'settings'
  | 'layers'
  | 'play'
  | 'pause'
  | 'plus'
  | 'check'
  | 'info'
  | 'like'
  | 'likeFilled'
  | 'dislike'
  | 'dislikeFilled'
  | 'library'
  | 'download'
  | 'subtitles'
  | 'audio'
  | 'speed'
  | 'aspect'
  | 'dots'
  | 'close'
  | 'back'
  | 'chevronRight'
  | 'skipBack'
  | 'skipForward'
  | 'lock'
  | 'list'
  | 'bell'
  | 'prevChannel'
  | 'keypad'
  | 'profile'
  | 'sources'
  | 'refresh'
  | 'trash'
  | 'warning'
  | 'volumeMute'
  | 'fullscreen'
  | 'fullscreenExit'
  | 'star'
  | 'starFilled'
  | 'chevronLeft'
  | 'chevronDown'
  | 'pin'
  | 'skipBack10'
  | 'skipForward10'
  | 'moon'
  | 'chapters'
  | 'skipPrev'
  | 'skipNext'
  | 'pip'
  | 'multiview'
  | 'miniplayer'
  | 'popout'
  | 'dock'
  | 'bookmark'
  | 'bookmarkFilled'
  | 'ban';

/** Single SVG primitive shape within a 24x24 icon viewBox. */
export type IconShape =
  | {
      readonly kind: 'path';
      readonly d: string;
      readonly fill?: 'currentColor' | 'none';
      readonly strokeWidth?: number;
    }
  | {
      readonly kind: 'circle';
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly fill?: 'currentColor' | 'none';
      readonly strokeWidth?: number;
    }
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx?: number;
      readonly fill?: 'currentColor' | 'none';
      readonly strokeWidth?: number;
    };

/** Vector definition for an icon; stroke shapes default to width 1.8 and fill `'none'`. */
export interface IconSpec {
  readonly viewBox: '0 0 24 24';
  readonly filled?: boolean;
  readonly shapes: readonly IconShape[];
}

const VB = '0 0 24 24' as const;

const p = (d: string, strokeWidth?: number): IconShape =>
  strokeWidth === undefined ? { kind: 'path', d } : { kind: 'path', d, strokeWidth };

const c = (cx: number, cy: number, rad: number, strokeWidth?: number): IconShape =>
  strokeWidth === undefined
    ? { kind: 'circle', cx, cy, r: rad }
    : { kind: 'circle', cx, cy, r: rad, strokeWidth };

const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
  rx?: number,
  strokeWidth?: number,
): IconShape => ({
  kind: 'rect',
  x,
  y,
  width,
  height,
  ...(rx !== undefined ? { rx } : {}),
  ...(strokeWidth !== undefined ? { strokeWidth } : {}),
});

const fp = (d: string): IconShape => ({ kind: 'path', d, fill: 'currentColor' });

const fc = (cx: number, cy: number, rad: number): IconShape => ({
  kind: 'circle',
  cx,
  cy,
  r: rad,
  fill: 'currentColor',
});

const stroke = (...shapes: IconShape[]): IconSpec => ({ viewBox: VB, shapes });
const filled = (...shapes: IconShape[]): IconSpec => ({ viewBox: VB, filled: true, shapes });

/** Registry of pure 24x24 vector shapes keyed by {@link IconName}. */
export const ICON_PATHS: Readonly<Record<IconName, IconSpec>> = {
  home: stroke(p('M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z')),
  tv: stroke(rect(2, 5, 20, 14, 2), p('M8 21h8M12 19v2')),
  film: stroke(rect(2, 4, 20, 16, 2), p('M7 4v16M17 4v16M2 12h20')),
  series: stroke(rect(3, 6, 18, 14, 2), p('M7 3h10')),
  search: stroke(c(11, 11, 7, 1.9), p('m20 20-3.5-3.5', 1.9)),
  settings: stroke(
    c(12, 12, 3),
    p(
      'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
    ),
  ),
  layers: stroke(p('M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5')),
  play: filled(fp('M6 4l14 8-14 8z')),
  pause: filled(fp('M6 5h4v14H6zM14 5h4v14h-4z')),
  plus: stroke(p('M12 5v14M5 12h14', 2)),
  check: stroke(p('M20 6 9 17l-5-5', 2.2)),
  info: stroke(c(12, 12, 9, 1.9), p('M12 11v5M12 8h.01', 1.9)),
  like: stroke(
    p(
      'M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z',
    ),
  ),
  likeFilled: filled(
    fp(
      'M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7V10l1.55-1.11L12 2a3.13 3.13 0 0 1 3 3.88ZM2 12a2 2 0 0 1 2-2h1.5v12H4a2 2 0 0 1-2-2v-8Z',
    ),
  ),
  dislike: stroke(
    p(
      'M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z',
    ),
  ),
  dislikeFilled: filled(
    fp(
      'M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H17v12l-1.55 1.11L12 22a3.13 3.13 0 0 1-3-3.88ZM22 12a2 2 0 0 1-2 2h-1.5V2H20a2 2 0 0 1 2 2v8Z',
    ),
  ),
  library: stroke(
    p(
      'M4 19.5V5.5a2 2 0 0 1 2-2h2v16H6a2 2 0 0 1-2-2zM10 3.5h4v16h-4zM16 4.5l4.2 1.2v14.8L16 19.5z',
    ),
  ),
  download: stroke(p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3')),
  subtitles: stroke(rect(2, 5, 20, 14, 2), p('M7 13h4M13 13h4M7 16h2M11 16h6')),
  audio: stroke(
    p('M11 5 6 9H2v6h4l5 4V5zM15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14'),
  ),
  speed: stroke(p('M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0')),
  aspect: stroke(rect(3, 5, 18, 14, 2), p('M7 9h2v2M17 15h-2v-2')),
  dots: filled(fc(12, 5, 1.6), fc(12, 12, 1.6), fc(12, 19, 1.6)),
  close: stroke(p('M18 6 6 18M6 6l12 12', 2)),
  back: stroke(p('M15 18l-6-6 6-6', 2)),
  chevronRight: stroke(p('M9 18l6-6-6-6', 2)),
  skipBack: stroke(p('M3 12a9 9 0 1 0 3-6.7L3 8', 1.7), p('M3 3v5h5', 1.7)),
  skipForward: stroke(p('M21 12a9 9 0 1 1-3-6.7L21 8', 1.7), p('M21 3v5h-5', 1.7)),
  lock: stroke(rect(3, 11, 18, 11, 2), p('M7 11V7a5 5 0 0 1 10 0v4')),
  list: stroke(p('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01')),
  bell: stroke(p('M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0')),
  prevChannel: stroke(p('M9 14 4 9l5-5'), p('M20 20v-7a4 4 0 0 0-4-4H4')),
  keypad: filled(...[6, 12, 18].flatMap((cy) => [6, 12, 18].map((cx) => fc(cx, cy, 1.6)))),
  profile: stroke(c(12, 7, 4), p('M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2')),
  sources: stroke(rect(2, 3, 20, 8, 2), rect(2, 13, 20, 8, 2), p('M6 7h.01M6 17h.01')),
  refresh: stroke(
    p('M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'),
    p('M21 3v5h-5'),
    p('M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'),
    p('M3 21v-5h5'),
  ),
  trash: stroke(
    p('M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'),
    p('M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6'),
  ),
  warning: stroke(
    p('M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'),
    p('M12 9v4M12 17h.01'),
  ),
  volumeMute: stroke(p('M11 5 6 9H2v6h4l5 4V5z'), p('m22 9-6 6M16 9l6 6')),
  fullscreen: stroke(
    p(
      'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3',
    ),
  ),
  fullscreenExit: stroke(
    p(
      'M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3',
    ),
  ),
  star: stroke(
    p(
      'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
    ),
  ),
  starFilled: filled(
    fp(
      'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
    ),
  ),
  chevronLeft: stroke(p('M15 18l-6-6 6-6', 2)),
  chevronDown: stroke(p('M6 9l6 6 6-6', 2)),
  pin: stroke(
    p('M12 17v5'),
    p(
      'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
    ),
  ),
  skipBack10: stroke(
    p('M3.5 13a8.5 8.5 0 1 0 2.5-6', 1.7),
    p('M6 3.8V7h3.2', 1.7),
    p('M8.7 10.1v5.8', 1.5),
    rect(11.7, 10.1, 3.6, 5.8, 1.8, 1.5),
  ),
  skipForward10: stroke(
    p('M20.5 13a8.5 8.5 0 1 1-2.5-6', 1.7),
    p('M18 3.8V7h-3.2', 1.7),
    p('M8.7 10.1v5.8', 1.5),
    rect(11.7, 10.1, 3.6, 5.8, 1.8, 1.5),
  ),
  moon: stroke(p('M12 3a6.5 6.5 0 0 0 9 9 9 9 0 1 1-9-9z')),
  chapters: stroke(p('M4 5h5v8.5l-2.5-1.8L4 13.5z'), p('M13 6.5h7M13 12h7M4 18h16')),
  skipPrev: filled(fp('M5 5h2.5v14H5z'), fp('M19 5v14L9 12z')),
  skipNext: filled(fp('M5 5v14l10-7z'), fp('M16.5 5H19v14h-2.5z')),
  pip: stroke(rect(2, 4, 20, 16, 2), rect(12, 11, 7.5, 6, 1.2)),
  multiview: stroke(
    rect(3, 4, 8, 7, 1.5),
    rect(13, 4, 8, 7, 1.5),
    rect(3, 13, 8, 7, 1.5),
    rect(13, 13, 8, 7, 1.5),
  ),
  miniplayer: stroke(
    rect(2, 4, 20, 16, 2),
    p('M7 9l4 4'),
    p('M11 9v4H7'),
    rect(13.5, 13, 6, 4.5, 1),
  ),
  popout: stroke(
    p('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'),
    p('M15 3h6v6'),
    p('M10 14 21 3'),
  ),
  dock: stroke(
    p('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'),
    p('M21 3 11 13'),
    p('M11 7v6h6'),
  ),
  bookmark: stroke(p('M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z')),
  bookmarkFilled: filled(fp('M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z')),
  ban: stroke(c(12, 12, 9), p('M5.64 5.64 18.36 18.36')),
};

/** Ordered list of every icon identifier registered in {@link ICON_PATHS}. */
export const ICON_NAMES: readonly IconName[] = Object.keys(ICON_PATHS) as IconName[];
