import type { TrailerExternalPort } from '@elv/features';
import { Linking } from 'react-native';

const ALLOWED_YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);

/** Minimal Linking surface injectable for unit tests (`#512`). */
export interface TrailerLinkingLike {
  openURL(url: string): Promise<unknown>;
}

/** Validates that a trailer URL is a clean HTTPS YouTube link without credentials or custom ports (`#512`). */
export function isAllowedMobileTrailerUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 512 || /[\s\0]/.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.port === '' &&
      ALLOWED_YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/** Creates the mobile/TV {@link TrailerExternalPort} opening strictly allowlisted HTTPS YouTube URLs via `Linking.openURL` (`#512`). */
export function createMobileTrailerExternalPort(
  options: { readonly linking?: TrailerLinkingLike } = {},
): TrailerExternalPort {
  const linking = options.linking ?? Linking;
  return {
    async openExternalUrl(url: string): Promise<boolean> {
      if (!isAllowedMobileTrailerUrl(url)) return false;
      try {
        await linking.openURL(url.trim());
        return true;
      } catch {
        return false;
      }
    },
  };
}
