type ArtworkAspect = '16:9' | '2:3';

type ArtworkMotif =
  | 'horizon'
  | 'orbital'
  | 'harbor'
  | 'lanterns'
  | 'meridian'
  | 'relay'
  | 'cinema'
  | 'arena'
  | 'nordic'
  | 'festival';

/** Specification for generating one deterministic synthetic cinema SVG data URI. */
export interface ArtworkSpec {
  readonly id: string;
  readonly aspect: ArtworkAspect;
  /** Four hex stops: `[deepBg, midTone, horizonGlow, accentHighlight]`. */
  readonly palette: readonly [string, string, string, string];
  readonly motif: ArtworkMotif;
}

interface HeroSpotlightItem {
  readonly id: string;
  readonly statusLine: string;
  readonly title: string;
  readonly match: string;
  readonly year: string;
  readonly duration: string;
  readonly quality: string;
  readonly rating: string;
  readonly synopsis: string;
  readonly imageUri: string;
}

interface WideRailItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly live?: boolean;
  readonly badge?: string;
  readonly logoBackdrop?: boolean;
  readonly progress: number;
  readonly imageUri: string;
}

interface PosterCatalogItem {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly genre: 'Sci-Fi' | 'Thriller' | 'Documentary' | 'Festival';
  readonly badge?: string;
  readonly progress?: number;
  readonly imageUri: string;
}

function motifShapes(
  motif: ArtworkMotif,
  w: number,
  h: number,
  palette: readonly [string, string, string, string],
): string {
  const [deep, mid, glow, accent] = palette;
  const cx = Math.round(w * 0.62);
  const cy = Math.round(h * 0.44);

  switch (motif) {
    case 'horizon':
      return [
        `<polygon points="${w * 0.42},0 ${w * 0.88},0 ${w * 0.66},${h * 0.72} ${w * 0.28},${h * 0.72}" fill="${accent}" opacity="0.14"/>`,
        `<path d="M0,${h * 0.66} Q${w * 0.26},${h * 0.5} ${w * 0.52},${h * 0.62} T${w},${h * 0.58} L${w},${h} L0,${h} Z" fill="${deep}" opacity="0.86"/>`,
        `<path d="M0,${h * 0.76} Q${w * 0.34},${h * 0.66} ${w * 0.68},${h * 0.74} T${w},${h * 0.7} L${w},${h} L0,${h} Z" fill="${deep}" opacity="0.95"/>`,
        `<rect x="${w * 0.14}" y="${h * 0.63}" width="${w * 0.72}" height="2" fill="${glow}" opacity="0.55"/>`,
      ].join('');
    case 'orbital':
      return [
        `<circle cx="${cx}" cy="${cy}" r="${Math.round(Math.min(w, h) * 0.28)}" fill="${deep}" stroke="${accent}" stroke-opacity="0.45" stroke-width="2"/>`,
        `<ellipse cx="${cx}" cy="${cy}" rx="${Math.round(w * 0.38)}" ry="${Math.round(h * 0.11)}" transform="rotate(-14 ${cx} ${cy})" fill="none" stroke="${glow}" stroke-opacity="0.65" stroke-width="2.5"/>`,
        `<circle cx="${cx - Math.round(w * 0.16)}" cy="${cy - Math.round(h * 0.14)}" r="5" fill="${accent}" opacity="0.9"/>`,
        `<path d="M0,${h * 0.82} L${w},${h * 0.74} L${w},${h} L0,${h} Z" fill="${deep}" opacity="0.9"/>`,
      ].join('');
    case 'harbor':
      return [
        `<rect x="0" y="${h * 0.64}" width="${w}" height="${h * 0.36}" fill="${deep}" opacity="0.88"/>`,
        `<rect x="${w * 0.18}" y="${h * 0.36}" width="${w * 0.08}" height="${h * 0.28}" fill="${mid}" opacity="0.72"/>`,
        `<rect x="${w * 0.3}" y="${h * 0.44}" width="${w * 0.14}" height="${h * 0.2}" fill="${deep}" opacity="0.84"/>`,
        `<rect x="${w * 0.68}" y="${h * 0.3}" width="${w * 0.11}" height="${h * 0.34}" fill="${deep}" opacity="0.82"/>`,
        `<rect x="${w * 0.14}" y="${h * 0.68}" width="${w * 0.24}" height="3" rx="1.5" fill="${glow}" opacity="0.5"/>`,
        `<rect x="${w * 0.56}" y="${h * 0.74}" width="${w * 0.3}" height="2" rx="1" fill="${accent}" opacity="0.45"/>`,
      ].join('');
    case 'lanterns':
      return [
        `<circle cx="${w * 0.34}" cy="${h * 0.36}" r="${Math.round(w * 0.08)}" fill="${glow}" opacity="0.34"/>`,
        `<circle cx="${w * 0.34}" cy="${h * 0.36}" r="${Math.round(w * 0.036)}" fill="${accent}" opacity="0.9"/>`,
        `<circle cx="${w * 0.66}" cy="${h * 0.28}" r="${Math.round(w * 0.1)}" fill="${glow}" opacity="0.28"/>`,
        `<circle cx="${w * 0.66}" cy="${h * 0.28}" r="${Math.round(w * 0.042)}" fill="${accent}" opacity="0.88"/>`,
        `<circle cx="${w * 0.52}" cy="${h * 0.52}" r="${Math.round(w * 0.06)}" fill="${glow}" opacity="0.24"/>`,
        `<path d="M0,${h * 0.72} L${w * 0.45},${h * 0.64} L${w},${h * 0.78} L${w},${h} L0,${h} Z" fill="${deep}" opacity="0.92"/>`,
      ].join('');
    case 'meridian':
      return [
        `<polygon points="${w * 0.52},0 ${w},0 ${w},${h * 0.76} ${w * 0.34},${h * 0.76}" fill="${accent}" opacity="0.12"/>`,
        `<line x1="${w * 0.56}" y1="0" x2="${w * 0.28}" y2="${h}" stroke="${glow}" stroke-opacity="0.55" stroke-width="2"/>`,
        `<line x1="${w * 0.74}" y1="0" x2="${w * 0.46}" y2="${h}" stroke="${accent}" stroke-opacity="0.35" stroke-width="1.5"/>`,
        `<rect x="0" y="${h * 0.72}" width="${w}" height="${h * 0.28}" fill="${deep}" opacity="0.9"/>`,
      ].join('');
    case 'relay':
      return [
        `<circle cx="${cx}" cy="${cy}" r="${Math.round(w * 0.14)}" fill="none" stroke="${glow}" stroke-opacity="0.5" stroke-width="2"/>`,
        `<circle cx="${cx}" cy="${cy}" r="${Math.round(w * 0.24)}" fill="none" stroke="${accent}" stroke-opacity="0.32" stroke-width="1.5"/>`,
        `<circle cx="${cx}" cy="${cy}" r="${Math.round(w * 0.34)}" fill="none" stroke="${glow}" stroke-opacity="0.18" stroke-width="1"/>`,
        `<rect x="${cx - 3}" y="${cy}" width="6" height="${h - cy}" fill="${deep}" opacity="0.92"/>`,
      ].join('');
    case 'cinema':
      return [
        `<polygon points="${w * 0.18},0 ${w * 0.72},${h} ${w * 0.46},${h} ${w * 0.04},0" fill="${glow}" opacity="0.16"/>`,
        `<polygon points="${w * 0.82},0 ${w * 0.54},${h} ${w * 0.28},${h} ${w * 0.64},0" fill="${accent}" opacity="0.14"/>`,
        `<rect x="0" y="${h * 0.76}" width="${w}" height="${h * 0.24}" fill="${deep}" opacity="0.88"/>`,
      ].join('');
    case 'arena':
      return [
        `<path d="M0,${h * 0.74} Q${w * 0.5},${h * 0.54} ${w},${h * 0.74} L${w},${h} L0,${h} Z" fill="${deep}" opacity="0.88"/>`,
        `<polygon points="${w * 0.14},${h * 0.16} ${w * 0.48},${h * 0.84} ${w * 0.26},${h * 0.84}" fill="${accent}" opacity="0.18"/>`,
        `<polygon points="${w * 0.86},${h * 0.16} ${w * 0.74},${h * 0.84} ${w * 0.52},${h * 0.84}" fill="${glow}" opacity="0.18"/>`,
        `<circle cx="${w * 0.14}" cy="${h * 0.16}" r="5" fill="${accent}" opacity="0.9"/>`,
        `<circle cx="${w * 0.86}" cy="${h * 0.16}" r="5" fill="${glow}" opacity="0.9"/>`,
      ].join('');
    case 'nordic':
      return [
        `<polygon points="0,${h * 0.74} ${w * 0.28},${h * 0.38} ${w * 0.54},${h * 0.68} ${w * 0.78},${h * 0.32} ${w},${h * 0.66} ${w},${h} 0,${h}" fill="${deep}" opacity="0.88"/>`,
        `<path d="M${w * 0.1},${h * 0.26} Q${w * 0.45},${h * 0.12} ${w * 0.88},${h * 0.28}" fill="none" stroke="${accent}" stroke-opacity="0.55" stroke-width="5" stroke-linecap="round"/>`,
      ].join('');
    case 'festival':
      return [
        `<polygon points="${w * 0.5},${h * 0.08} ${w * 0.88},${h} ${w * 0.12},${h}" fill="${glow}" opacity="0.18"/>`,
        `<circle cx="${w * 0.5}" cy="${h * 0.34}" r="${Math.round(Math.min(w, h) * 0.16)}" fill="${accent}" opacity="0.22"/>`,
        `<rect x="0" y="${h * 0.78}" width="${w}" height="${h * 0.22}" fill="${deep}" opacity="0.9"/>`,
      ].join('');
  }
}

/**
 * Generates a deterministic, CSP-safe `data:image/svg+xml;utf8,...` atmospheric cinema still or
 * poster URI with layered gradients, horizon glow, and geometric silhouettes.
 */
export function createSyntheticArtwork(spec: ArtworkSpec): string {
  const w = spec.aspect === '16:9' ? 640 : 360;
  const h = spec.aspect === '16:9' ? 360 : 540;
  const [deep, mid, glow, accent] = spec.palette;
  const gx = spec.aspect === '16:9' ? '68%' : '56%';
  const gy = spec.aspect === '16:9' ? '40%' : '34%';

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">`,
    '<defs>',
    `<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">`,
    `<stop offset="0%" stop-color="${deep}"/>`,
    `<stop offset="52%" stop-color="${mid}"/>`,
    `<stop offset="100%" stop-color="${deep}"/>`,
    '</linearGradient>',
    `<radialGradient id="glow" cx="${gx}" cy="${gy}" r="58%">`,
    `<stop offset="0%" stop-color="${glow}" stop-opacity="0.58"/>`,
    `<stop offset="48%" stop-color="${accent}" stop-opacity="0.18"/>`,
    `<stop offset="100%" stop-color="${deep}" stop-opacity="0"/>`,
    '</radialGradient>',
    `<linearGradient id="vig" x1="0%" y1="0%" x2="0%" y2="100%">`,
    `<stop offset="0%" stop-color="${deep}" stop-opacity="0.22"/>`,
    `<stop offset="65%" stop-color="${deep}" stop-opacity="0"/>`,
    `<stop offset="100%" stop-color="${deep}" stop-opacity="0.72"/>`,
    '</linearGradient>',
    '</defs>',
    `<rect width="${w}" height="${h}" fill="url(#bg)"/>`,
    `<rect width="${w}" height="${h}" fill="url(#glow)"/>`,
    motifShapes(spec.motif, w, h, spec.palette),
    `<rect width="${w}" height="${h}" fill="url(#vig)"/>`,
    '</svg>',
  ].join('');

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Three featured synthetic Hero spotlights for the Cinema Quietude gallery carousel. */
export const HERO_SPOTLIGHTS: readonly [HeroSpotlightItem, ...HeroSpotlightItem[]] = [
  {
    id: 'hero-silent-horizon',
    statusLine: 'Featured Tonight · 4K HDR',
    title: 'Silent Horizon',
    match: '98% Match',
    year: '2026',
    duration: '2h 14m',
    quality: '4K HDR',
    rating: '16+',
    synopsis:
      'When a deep-space relay goes dark over an oceanic moon, an acoustic archivist decodes a signal echoing forty years ahead of its time.',
    imageUri: createSyntheticArtwork({
      id: 'hero-silent-horizon',
      aspect: '16:9',
      palette: ['#070A12', '#17233A', '#E11D48', '#38BDF8'],
      motif: 'horizon',
    }),
  },
  {
    id: 'hero-orbital-nine',
    statusLine: 'Editors’ Pick · 4K HDR',
    title: 'Orbital Nine',
    match: '95% Match',
    year: '2025',
    duration: '1h 58m',
    quality: '4K HDR',
    rating: '13+',
    synopsis:
      'Nine engineers aboard a retiring orbital observatory race a solar storm to bring an unmapped comet into focus before dawn.',
    imageUri: createSyntheticArtwork({
      id: 'hero-orbital-nine',
      aspect: '16:9',
      palette: ['#060A14', '#12213F', '#3B82F6', '#7DD3FC'],
      motif: 'orbital',
    }),
  },
  {
    id: 'hero-glass-meridian',
    statusLine: 'Festival Premiere · 4K HDR',
    title: 'Glass Meridian',
    match: '96% Match',
    year: '2026',
    duration: '2h 06m',
    quality: '4K HDR',
    rating: '16+',
    synopsis:
      'Across rain-slicked harbor terminals, a maritime cartographer uncovers a ghost vessel charting routes that vanish from every ledger.',
    imageUri: createSyntheticArtwork({
      id: 'hero-glass-meridian',
      aspect: '16:9',
      palette: ['#0A0908', '#221C16', '#F59E0B', '#FDE68A'],
      motif: 'meridian',
    }),
  },
];

/** Synthetic 16:9 Continue Watching and Live Broadcast items for the wide rail. */
export const WIDE_RAIL_ITEMS: readonly WideRailItem[] = [
  {
    id: 'wide-cinema-one',
    title: 'Velvet Cinema 4K',
    subtitle: 'Ch 101 · Silent Horizon',
    live: true,
    badge: 'UHD',
    progress: 0.62,
    imageUri: createSyntheticArtwork({
      id: 'wide-cinema-one',
      aspect: '16:9',
      palette: ['#090A10', '#1E1A2E', '#E11D48', '#FB7185'],
      motif: 'cinema',
    }),
  },
  {
    id: 'wide-arena-sports',
    title: 'Pitch Sports 1',
    subtitle: 'Ch 201 · Evening Match',
    live: true,
    badge: '50fps',
    progress: 0.35,
    imageUri: createSyntheticArtwork({
      id: 'wide-arena-sports',
      aspect: '16:9',
      palette: ['#070C0B', '#112922', '#10B981', '#6EE7B7'],
      motif: 'arena',
    }),
  },
  {
    id: 'wide-midnight-relay',
    title: 'Midnight Relay · S1 E4',
    subtitle: '24m left',
    progress: 0.54,
    imageUri: createSyntheticArtwork({
      id: 'wide-midnight-relay',
      aspect: '16:9',
      palette: ['#080912', '#191D34', '#A855F7', '#C084FC'],
      motif: 'relay',
    }),
  },
  {
    id: 'wide-nordic-horizon',
    title: 'Nordic Horizon',
    subtitle: 'Ch 304 · Coastline Stories',
    live: true,
    badge: 'HD',
    progress: 0.48,
    imageUri: createSyntheticArtwork({
      id: 'wide-nordic-horizon',
      aspect: '16:9',
      palette: ['#070B12', '#142738', '#0EA5E9', '#67E8F9'],
      motif: 'nordic',
    }),
  },
  {
    id: 'wide-festival-24',
    title: 'Festival 24',
    subtitle: 'Ch 410 · Director’s Cut',
    live: true,
    badge: '4K',
    progress: 0.78,
    imageUri: createSyntheticArtwork({
      id: 'wide-festival-24',
      aspect: '16:9',
      palette: ['#0C0908', '#291D14', '#F59E0B', '#FBBF24'],
      motif: 'festival',
    }),
  },
];

/** Six synthetic 2:3 catalog posters filterable by genre in {@link DesignGallery}. */
export const POSTER_CATALOG: readonly PosterCatalogItem[] = [
  {
    id: 'poster-silent-horizon',
    title: 'Silent Horizon',
    meta: '2026 · 8.6',
    genre: 'Sci-Fi',
    badge: '4K',
    imageUri: createSyntheticArtwork({
      id: 'poster-silent-horizon',
      aspect: '2:3',
      palette: ['#070A12', '#1A2640', '#E11D48', '#38BDF8'],
      motif: 'horizon',
    }),
  },
  {
    id: 'poster-orbital-nine',
    title: 'Orbital Nine',
    meta: '2025 · 8.2',
    genre: 'Sci-Fi',
    progress: 0.4,
    imageUri: createSyntheticArtwork({
      id: 'poster-orbital-nine',
      aspect: '2:3',
      palette: ['#060B15', '#152544', '#3B82F6', '#93C5FD'],
      motif: 'orbital',
    }),
  },
  {
    id: 'poster-harbor-lights',
    title: 'Harbor Lights',
    meta: '2025 · 8.1',
    genre: 'Documentary',
    imageUri: createSyntheticArtwork({
      id: 'poster-harbor-lights',
      aspect: '2:3',
      palette: ['#080C10', '#162834', '#14B8A6', '#5EEAD4'],
      motif: 'harbor',
    }),
  },
  {
    id: 'poster-paper-lanterns',
    title: 'Paper Lanterns',
    meta: '2026 · 8.5',
    genre: 'Festival',
    badge: 'HDR',
    imageUri: createSyntheticArtwork({
      id: 'poster-paper-lanterns',
      aspect: '2:3',
      palette: ['#0D090A', '#2B181C', '#F43F5E', '#FBBF24'],
      motif: 'lanterns',
    }),
  },
  {
    id: 'poster-glass-meridian',
    title: 'Glass Meridian',
    meta: '2026 · 8.4',
    genre: 'Thriller',
    badge: '4K',
    imageUri: createSyntheticArtwork({
      id: 'poster-glass-meridian',
      aspect: '2:3',
      palette: ['#0A0908', '#251D15', '#F59E0B', '#FDE68A'],
      motif: 'meridian',
    }),
  },
  {
    id: 'poster-midnight-relay',
    title: 'Midnight Relay',
    meta: '2025 · 8.3',
    genre: 'Thriller',
    progress: 0.68,
    imageUri: createSyntheticArtwork({
      id: 'poster-midnight-relay',
      aspect: '2:3',
      palette: ['#090812', '#1E1838', '#A855F7', '#E879F9'],
      motif: 'relay',
    }),
  },
];

/** Flat lookup map of all pre-generated synthetic artwork URIs by item id. */
export const SYNTHETIC_ARTWORK_BY_ID: Readonly<Record<string, string>> = Object.fromEntries(
  [...HERO_SPOTLIGHTS, ...WIDE_RAIL_ITEMS, ...POSTER_CATALOG].map((item) => [
    item.id,
    item.imageUri,
  ]),
);
