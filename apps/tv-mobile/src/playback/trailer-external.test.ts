import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Linking: {
    openURL: vi.fn(async () => undefined),
  },
}));

import { createMobileTrailerExternalPort, isAllowedMobileTrailerUrl } from './trailer-external';

describe('createMobileTrailerExternalPort (#512)', () => {
  it('enforces strict https YouTube allowlist', () => {
    expect(isAllowedMobileTrailerUrl('https://www.youtube.com/watch?v=8g18jFHCLXk')).toBe(true);
    expect(isAllowedMobileTrailerUrl('https://youtu.be/8g18jFHCLXk')).toBe(true);
    expect(isAllowedMobileTrailerUrl('http://www.youtube.com/watch?v=8g18jFHCLXk')).toBe(false);
    expect(isAllowedMobileTrailerUrl('https://notyoutube.com/watch?v=8g18jFHCLXk')).toBe(false);
    expect(isAllowedMobileTrailerUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedMobileTrailerUrl('https://u:p@youtu.be/8g18jFHCLXk')).toBe(false);
  });

  it('calls Linking.openURL for allowlisted URLs and rejects invalid ones', async () => {
    const openURL = vi.fn(async () => undefined);
    const port = createMobileTrailerExternalPort({ linking: { openURL } });

    expect(await port.openExternalUrl('https://www.youtube.com/watch?v=8g18jFHCLXk')).toBe(true);
    expect(openURL).toHaveBeenCalledWith('https://www.youtube.com/watch?v=8g18jFHCLXk');

    expect(await port.openExternalUrl('https://evil.invalid/video')).toBe(false);
    expect(openURL).toHaveBeenCalledTimes(1);
  });

  it('returns false when Linking.openURL rejects', async () => {
    const port = createMobileTrailerExternalPort({
      linking: {
        openURL: vi.fn(async () => {
          throw new Error('no handler');
        }),
      },
    });
    expect(await port.openExternalUrl('https://youtu.be/8g18jFHCLXk')).toBe(false);
  });
});
