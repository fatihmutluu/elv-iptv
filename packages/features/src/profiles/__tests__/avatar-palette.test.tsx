import { PROFILE_AVATAR_TOKENS } from '@elv/data';
import { buildTheme } from '@elv/ui-kit';
import {
  getProfileAvatarPreset,
  getProfileInitials,
  PROFILE_AVATAR_PRESETS,
  resolveProfileAvatarColors,
} from '../avatar-palette';

describe('avatar-palette', () => {
  it('resolves distinct, non-empty theme colors for all 9 ProfileAvatarTokens in default and High Contrast AAA themes', () => {
    const standard = buildTheme({ preset: 'obsidianCrimson' });
    const highContrast = buildTheme({ preset: 'highContrast' });

    expect(PROFILE_AVATAR_TOKENS).toHaveLength(9);
    const seenBg = new Set<string>();

    for (const token of PROFILE_AVATAR_TOKENS) {
      const stdColors = resolveProfileAvatarColors(token, standard);
      expect(stdColors.bg).toBeTruthy();
      expect(stdColors.fg).toBeTruthy();
      seenBg.add(stdColors.bg);

      const hcColors = resolveProfileAvatarColors(token, highContrast);
      expect(hcColors.bg).toBeTruthy();
      expect(hcColors.fg).toBeTruthy();
    }

    expect(seenBg.size).toBe(9);
  });

  it('registers 9 distinct illustrated vector presets with valid 24x24 IconSpec shapes', () => {
    const motifs = new Set<string>();
    const signatures = new Set<string>();

    for (const token of PROFILE_AVATAR_TOKENS) {
      const preset = getProfileAvatarPreset(token);
      expect(preset).toBe(PROFILE_AVATAR_PRESETS[token]);
      expect(preset.token).toBe(token);
      expect(preset.motif).toBeTruthy();
      expect(preset.artwork.viewBox).toBe('0 0 24 24');
      expect(preset.artwork.shapes.length).toBeGreaterThanOrEqual(3);

      motifs.add(preset.motif);
      signatures.add(JSON.stringify(preset.artwork.shapes));
    }

    expect(motifs.size).toBe(9);
    expect(signatures.size).toBe(9);
  });

  it('extracts crisp 1-2 letter uppercase initials', () => {
    expect(getProfileInitials('Default')).toBe('D');
    expect(getProfileInitials('Jane Doe')).toBe('JD');
    expect(getProfileInitials('  alex   rivera  jr ')).toBe('AR');
    expect(getProfileInitials('   ')).toBe('P');
  });
});
