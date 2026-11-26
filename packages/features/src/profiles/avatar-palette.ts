import type { ProfileAvatarToken } from '@elv/data';
import { type IconSpec, parseHexColor, THEME_PRESETS, type Theme } from '@elv/ui-kit';

/** Resolved background and foreground colors for a {@link ProfileAvatarToken}. */
export interface ProfileAvatarColors {
  readonly bg: string;
  readonly fg: string;
}

/** Named character/portrait motif rendered inside {@link ProfileAvatarBadge}. */
export type ProfileAvatarMotif =
  | 'explorer'
  | 'astronaut'
  | 'cat'
  | 'robot'
  | 'cool'
  | 'headphones'
  | 'crown'
  | 'wizard'
  | 'buddy';

/** Structured local avatar preset enabling effortless future artwork swaps. */
export interface ProfileAvatarPreset {
  readonly token: ProfileAvatarToken;
  readonly motif: ProfileAvatarMotif;
  readonly artwork: IconSpec;
  readonly resolveColors: (theme: Theme) => ProfileAvatarColors;
}

const VB = '0 0 24 24' as const;

function mixThemeHex(hexA: string, hexB: string, ratioB: number): string {
  const a = parseHexColor(hexA);
  const b = parseHexColor(hexB);
  const t = Math.min(1, Math.max(0, ratioB));
  const r = Math.round(a.r * (1 - t) + b.r * t);
  const g = Math.round(a.g * (1 - t) + b.g * t);
  const bl = Math.round(a.b * (1 - t) + b.b * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

/** Crisp 24x24 edit pencil vector glyph shared by profile hover/touch/TV edit triggers. */
export const PENCIL_ICON_SPEC: IconSpec = {
  viewBox: VB,
  shapes: [
    { kind: 'path', d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5z' },
    { kind: 'path', d: 'M14 6l4 4' },
  ],
};

/**
 * Clean 9-entry local circular avatar preset registry (zero hardcoded hex literals).
 * Every color derives from `@elv/ui-kit` theme presets/tokens; every motif is a crisp 24x24 SVG.
 */
export const PROFILE_AVATAR_PRESETS: Readonly<Record<ProfileAvatarToken, ProfileAvatarPreset>> = {
  crimson: {
    token: 'crimson',
    motif: 'explorer',
    artwork: {
      viewBox: VB,
      shapes: [
        { kind: 'path', d: 'M5 21c1.2-3.2 3.8-4.8 7-4.8s5.8 1.6 7 4.8' },
        { kind: 'circle', cx: 12, cy: 11.2, r: 4.1 },
        { kind: 'path', d: 'M7.5 9.2C8.3 6.2 10 5 12 5s3.7 1.2 4.5 4.2' },
        { kind: 'path', d: 'M6.5 9.2h12.2' },
        { kind: 'circle', cx: 10.6, cy: 11.3, r: 0.7, fill: 'currentColor' },
        { kind: 'circle', cx: 13.4, cy: 11.3, r: 0.7, fill: 'currentColor' },
        { kind: 'path', d: 'M10.5 13.3c.8.7 2.2.7 3 0' },
      ],
    },
    resolveColors: () => ({
      bg: THEME_PRESETS.obsidianCrimson.accent,
      fg: THEME_PRESETS.obsidianCrimson.accentContrast,
    }),
  },
  sapphire: {
    token: 'sapphire',
    motif: 'astronaut',
    artwork: {
      viewBox: VB,
      shapes: [
        { kind: 'path', d: 'M5 21c1.3-3 3.9-4.5 7-4.5s5.7 1.5 7 4.5' },
        { kind: 'circle', cx: 12, cy: 10.8, r: 5.2 },
        { kind: 'rect', x: 8.6, y: 8.8, width: 6.8, height: 4, rx: 2 },
        { kind: 'path', d: 'M12 5.6V3.5' },
        { kind: 'circle', cx: 12, cy: 2.9, r: 0.8, fill: 'currentColor' },
      ],
    },
    resolveColors: () => ({
      bg: THEME_PRESETS.abyssalSapphire.accent,
      fg: THEME_PRESETS.abyssalSapphire.accentContrast,
    }),
  },
  amber: {
    token: 'amber',
    motif: 'cat',
    artwork: {
      viewBox: VB,
      shapes: [
        { kind: 'path', d: 'M5.5 21c1.1-2.8 3.5-4.3 6.5-4.3s5.4 1.5 6.5 4.3' },
        { kind: 'path', d: 'M7.6 10.4L7 5.6l3.3 2.4a5 5 0 0 1 3.4 0L17 5.6l-.6 4.8' },
        { kind: 'circle', cx: 12, cy: 11.4, r: 4.5 },
        { kind: 'circle', cx: 10.4, cy: 11, r: 0.75, fill: 'currentColor' },
        { kind: 'circle', cx: 13.6, cy: 11, r: 0.75, fill: 'currentColor' },
        { kind: 'path', d: 'M10.4 13.1c.6.6 1.2.6 1.6 0 .4.6 1 .6 1.6 0' },
      ],
    },
    resolveColors: () => ({
      bg: THEME_PRESETS.theaterAmber.accent,
      fg: THEME_PRESETS.theaterAmber.accentContrast,
    }),
  },
  violet: {
    token: 'violet',
    motif: 'robot',
    artwork: {
      viewBox: VB,
      shapes: [
        { kind: 'path', d: 'M5.5 21c1.2-2.8 3.6-4.2 6.5-4.2s5.3 1.4 6.5 4.2' },
        { kind: 'rect', x: 6.5, y: 6.5, width: 11, height: 8.8, rx: 2.6 },
        { kind: 'path', d: 'M12 6.5V4' },
        { kind: 'circle', cx: 12, cy: 3.3, r: 0.85, fill: 'currentColor' },
        { kind: 'circle', cx: 9.8, cy: 10.6, r: 0.9, fill: 'currentColor' },
        { kind: 'circle', cx: 14.2, cy: 10.6, r: 0.9, fill: 'currentColor' },
        { kind: 'path', d: 'M9.5 13.2h5' },
      ],
    },
    resolveColors: () => ({
      bg: THEME_PRESETS.velvetViolet.accent,
      fg: THEME_PRESETS.velvetViolet.accentContrast,
    }),
  },
  emerald: {
    token: 'emerald',
    motif: 'cool',
    artwork: {
      viewBox: VB,
      shapes: [
        { kind: 'path', d: 'M5 21c1.2-3.2 3.8-4.8 7-4.8s5.8 1.6 7 4.8' },
        { kind: 'circle', cx: 12, cy: 10.6, r: 4.7 },
        { kind: 'rect', x: 7.4, y: 9.1, width: 3.8, height: 2.5, rx: 0.8, fill: 'currentColor' },
        { kind: 'rect', x: 12.8, y: 9.1, width: 3.8, height: 2.5, rx: 0.8, fill: 'currentColor' },
        { kind: 'path', d: 'M11.2 10h1.6' },
        { kind: 'path', d: 'M10.4 13.2c1 .7 2.4.7 3.4-.1' },
      ],
    },
    resolveColors: () => ({
      bg: THEME_PRESETS.pitchEmerald.accent,
      fg: THEME_PRESETS.pitchEmerald.accentContrast,
    }),
  },
  slate: {
    token: 'slate',
    motif: 'headphones',
    artwork: {
      viewBox: VB,
      shapes: [
        { kind: 'path', d: 'M5.5 21c1.2-3 3.6-4.5 6.5-4.5s5.3 1.5 6.5 4.5' },
        { kind: 'path', d: 'M6.2 11.4a5.8 5.8 0 0 1 11.6 0' },
        { kind: 'rect', x: 4.8, y: 10.2, width: 2.2, height: 4, rx: 1, fill: 'currentColor' },
        { kind: 'rect', x: 17, y: 10.2, width: 2.2, height: 4, rx: 1, fill: 'currentColor' },
        { kind: 'circle', cx: 12, cy: 11.4, r: 3.9 },
        { kind: 'circle', cx: 10.7, cy: 11.1, r: 0.65, fill: 'currentColor' },
        { kind: 'circle', cx: 13.3, cy: 11.1, r: 0.65, fill: 'currentColor' },
        { kind: 'path', d: 'M10.6 13c.8.7 2 .7 2.8 0' },
      ],
    },
    resolveColors: (theme) => ({
      bg: theme.colors.bgElevated,
      fg: theme.colors.textPrimary,
    }),
  },
  coral: {
    token: 'coral',
    motif: 'crown',
    artwork: {
      viewBox: VB,
      shapes: [
        { kind: 'path', d: 'M5 21c1.2-3 3.8-4.5 7-4.5s5.8 1.5 7 4.5' },
        { kind: 'path', d: 'M8 7.8L8.8 4.4 12 6.6l3.2-2.2.8 3.4z' },
        { kind: 'circle', cx: 12, cy: 12.1, r: 4.1 },
        { kind: 'circle', cx: 10.6, cy: 11.8, r: 0.7, fill: 'currentColor' },
        { kind: 'circle', cx: 13.4, cy: 11.8, r: 0.7, fill: 'currentColor' },
        { kind: 'path', d: 'M10.5 13.8c.9.7 2.1.7 3 0' },
      ],
    },
    resolveColors: () => ({
      bg: mixThemeHex(
        THEME_PRESETS.obsidianCrimson.accentSecondary,
        THEME_PRESETS.theaterAmber.accent,
        0.42,
      ),
      fg: THEME_PRESETS.theaterAmber.accentContrast,
    }),
  },
  teal: {
    token: 'teal',
    motif: 'wizard',
    artwork: {
      viewBox: VB,
      shapes: [
        { kind: 'path', d: 'M5.2 21c1.2-2.8 3.7-4.3 6.8-4.3s5.6 1.5 6.8 4.3' },
        { kind: 'path', d: 'M7 9.4l5-6.2 5 6.2' },
        { kind: 'path', d: 'M5.6 9.4h12.8' },
        { kind: 'circle', cx: 12, cy: 12.8, r: 3.7 },
        { kind: 'circle', cx: 10.7, cy: 12.6, r: 0.65, fill: 'currentColor' },
        { kind: 'circle', cx: 13.3, cy: 12.6, r: 0.65, fill: 'currentColor' },
        { kind: 'path', d: 'M10.8 14.3c.7.5 1.7.5 2.4 0' },
      ],
    },
    resolveColors: () => ({
      bg: mixThemeHex(
        THEME_PRESETS.abyssalSapphire.bgElevated,
        THEME_PRESETS.pitchEmerald.accent,
        0.72,
      ),
      fg: THEME_PRESETS.obsidianCrimson.accentContrast,
    }),
  },
  indigo: {
    token: 'indigo',
    motif: 'buddy',
    artwork: {
      viewBox: VB,
      shapes: [
        { kind: 'path', d: 'M5 21c1.2-3.2 3.8-4.8 7-4.8s5.8 1.6 7 4.8' },
        { kind: 'circle', cx: 12, cy: 10.8, r: 4.7 },
        { kind: 'path', d: 'M8.4 7.7c1.4-1.7 4.8-2.2 6.8-.4' },
        { kind: 'circle', cx: 10.3, cy: 10.4, r: 0.8, fill: 'currentColor' },
        { kind: 'path', d: 'M12.9 10.4c.5-.5 1.3-.5 1.8 0' },
        { kind: 'path', d: 'M9.8 12.8c1.2 1.1 3.2 1.1 4.4 0' },
      ],
    },
    resolveColors: () => ({
      bg: mixThemeHex(
        THEME_PRESETS.abyssalSapphire.accent,
        THEME_PRESETS.velvetViolet.accent,
        0.45,
      ),
      fg: THEME_PRESETS.velvetViolet.accentContrast,
    }),
  },
};

/** Returns the structured {@link ProfileAvatarPreset} for a given {@link ProfileAvatarToken}. */
export function getProfileAvatarPreset(token: ProfileAvatarToken): ProfileAvatarPreset {
  return PROFILE_AVATAR_PRESETS[token] ?? PROFILE_AVATAR_PRESETS.crimson;
}

/**
 * Resolves a {@link ProfileAvatarToken} into high-contrast background/foreground colors
 * derived exclusively from `@elv/ui-kit` theme presets and active theme tokens (zero hardcoded hex).
 */
export function resolveProfileAvatarColors(
  token: ProfileAvatarToken,
  theme: Theme,
): ProfileAvatarColors {
  if (theme.highContrast) {
    return {
      bg: token === 'slate' ? theme.colors.bgElevated : theme.colors.accent,
      fg: token === 'slate' ? theme.colors.textPrimary : theme.colors.accentContrast,
    };
  }
  return getProfileAvatarPreset(token).resolveColors(theme);
}

/** Extracts 1–2 crisp uppercase monogram letters from a profile display name. */
export function getProfileInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return 'P';
  const first = parts[0] ?? '';
  if (parts.length === 1) {
    return first.slice(0, 1).toUpperCase();
  }
  const second = parts[1] ?? '';
  return `${first.slice(0, 1)}${second.slice(0, 1)}`.toUpperCase();
}
