import { describe, expect, it } from 'vitest';
import { compareSemver, isNewerVersion, sanitizeReleaseNotes } from './release-notes-sanitize.ts';

describe('sanitizeReleaseNotes', () => {
  it('strips HTML tags, dangerous script/iframe blocks, and dangerous URI schemes', () => {
    const raw = [
      '<h2>Highlights</h2>',
      '<script>alert("xss")</script>',
      '<iframe src="https://evil.invalid">frame body</iframe>',
      '<img src="https://tracker.invalid/px.gif" onerror="evil()" />',
      '- Fixed [click me](javascript:alert(1)) and [data](data:text/html;base64,PHNjcmlwdD4=)',
      '- Blocked [vb](vbscript:msgbox(1)) and ![badge](https://img.invalid/x.png)',
      '- Kept [release notes](https://github.com/fatihmutluu/elv-iptv/releases/tag/v1.2.0)',
      'Plain text with \u0000control\u0007 chars\r\nSecond line',
    ].join('\r\n');

    const cleaned = sanitizeReleaseNotes(raw);
    expect(cleaned).not.toContain('<script');
    expect(cleaned).not.toContain('alert("xss")');
    expect(cleaned).not.toContain('<iframe');
    expect(cleaned).not.toContain('frame body');
    expect(cleaned).not.toContain('<img');
    expect(cleaned).not.toContain('<h2>');
    expect(cleaned).not.toContain('javascript:');
    expect(cleaned).not.toContain('data:text/html');
    expect(cleaned).not.toContain('vbscript:');
    expect(cleaned).not.toContain('tracker.invalid');
    expect(cleaned).not.toContain('img.invalid');
    expect(cleaned).not.toContain('\u0000');
    expect(cleaned).not.toContain('\u0007');
    expect(cleaned).not.toContain('\r');
    expect(cleaned).toContain('Highlights');
    expect(cleaned).toContain('Fixed click me');
    expect(cleaned).toContain('Plain text with control chars\nSecond line');
  });

  it('caps line count and maxChars cleanly and handles non-strings', () => {
    expect(sanitizeReleaseNotes(null)).toBe('');
    expect(sanitizeReleaseNotes(undefined)).toBe('');
    expect(sanitizeReleaseNotes(42)).toBe('');

    const longText = 'A'.repeat(5000);
    const capped = sanitizeReleaseNotes(longText, 120);
    expect(capped.length).toBeLessThanOrEqual(120);
    expect(capped.endsWith('…')).toBe(true);

    const manyLines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join('\n');
    const lineCapped = sanitizeReleaseNotes(manyLines, 4000, 10);
    expect(lineCapped.split('\n').length).toBeLessThanOrEqual(11);
    expect(lineCapped.endsWith('…')).toBe(true);
  });
});

describe('compareSemver and isNewerVersion', () => {
  it('compares standard and prerelease semver strings accurately', () => {
    expect(compareSemver('1.2.0', '1.1.9')).toBe(1);
    expect(compareSemver('v1.2.0', '1.2.0')).toBe(0);
    expect(compareSemver('1.2.0', '2.0.0')).toBe(-1);
    expect(compareSemver('1.2.0', '1.2.0-rc.1')).toBe(1);
    expect(compareSemver('1.2.0-beta.2', '1.2.0-beta.10')).toBe(-1);
    expect(compareSemver('1.2.0-alpha.1', '1.2.0-alpha.beta')).toBe(-1);
    expect(compareSemver('1.2.0+build.123', '1.2.0+build.999')).toBe(0);
    expect(() => compareSemver('not-a-version', '1.0.0')).toThrow();
  });

  it('ignores prerelease candidates unless current version is also a prerelease', () => {
    expect(isNewerVersion('1.1.0', '1.0.0')).toBe(true);
    expect(isNewerVersion('v1.0.1', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);

    // Stable users ignore prereleases
    expect(isNewerVersion('2.0.0-rc.1', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.1-beta.1', '1.0.0')).toBe(false);

    // Prerelease users accept newer prereleases AND stable promotion
    expect(isNewerVersion('1.1.0-beta.2', '1.1.0-beta.1')).toBe(true);
    expect(isNewerVersion('1.1.0', '1.1.0-beta.2')).toBe(true);
    expect(isNewerVersion('1.1.0-alpha.1', '1.1.0-beta.1')).toBe(false);

    // Invalid strings never claim newer
    expect(isNewerVersion('invalid', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.2.0', 'invalid')).toBe(false);
  });
});
