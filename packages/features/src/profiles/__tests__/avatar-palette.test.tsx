import { PROFILE_AVATAR_TOKENS } from '@elv/data';
import { buildTheme } from '@elv/ui-kit';
import { getProfileInitials, resolveProfileAvatarColors } from '../avatar-palette';

describe('avatar-palette', () => {
  it('resolves non-empty theme colors for every ProfileAvatarToken in default and High Contrast AAA themes', () => {
    const standard = buildTheme({ preset: 'obsidianCrimson' });
    const highContrast = buildTheme({ preset: 'highContrast' });

    for (const token of PROFILE_AVATAR_TOKENS) {
      const stdColors = resolveProfileAvatarColors(token, standard);
      expect(stdColors.bg).toBeTruthy();
      expect(stdColors.fg).toBeTruthy();

      const hcColors = resolveProfileAvatarColors(token, highContrast);
      expect(hcColors.bg).toBeTruthy();
      expect(hcColors.fg).toBeTruthy();
    }
  });

  it('extracts crisp 1-2 letter uppercase initials', () => {
    expect(getProfileInitials('Default')).toBe('D');
    expect(getProfileInitials('Jane Doe')).toBe('JD');
    expect(getProfileInitials('  alex   rivera  jr ')).toBe('AR');
    expect(getProfileInitials('   ')).toBe('P');
  });
});
