import type { ProfileAvatarToken } from '@elv/data';
import { THEME_PRESETS, type Theme } from '@elv/ui-kit';

/** Resolved background and foreground colors for a {@link ProfileAvatarToken}. */
export interface ProfileAvatarColors {
  readonly bg: string;
  readonly fg: string;
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
  switch (token) {
    case 'crimson':
      return {
        bg: THEME_PRESETS.obsidianCrimson.accent,
        fg: THEME_PRESETS.obsidianCrimson.accentContrast,
      };
    case 'sapphire':
      return {
        bg: THEME_PRESETS.abyssalSapphire.accent,
        fg: THEME_PRESETS.abyssalSapphire.accentContrast,
      };
    case 'amber':
      return {
        bg: THEME_PRESETS.theaterAmber.accent,
        fg: THEME_PRESETS.theaterAmber.accentContrast,
      };
    case 'violet':
      return {
        bg: THEME_PRESETS.velvetViolet.accent,
        fg: THEME_PRESETS.velvetViolet.accentContrast,
      };
    case 'emerald':
      return {
        bg: THEME_PRESETS.pitchEmerald.accent,
        fg: THEME_PRESETS.pitchEmerald.accentContrast,
      };
    case 'slate':
      return {
        bg: theme.colors.bgElevated,
        fg: theme.colors.textPrimary,
      };
  }
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
