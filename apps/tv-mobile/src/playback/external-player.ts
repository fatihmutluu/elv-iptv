import { normalizeExternalPlayerScheme } from '@elv/domain';
import * as media3 from '@elv/engine-media3';
import type {
  ExternalPlayerPort,
  ExternalPlayerRequest,
  ExternalPlayerResult,
} from '@elv/features';
import { Linking, Platform } from 'react-native';

const EXTERNAL_RETURN_URL = 'elviptv://external-return';
const HTTP_STREAM_URL_RE = /^https?:\/\/\S+$/i;

interface Media3ExternalPlayerBridge {
  readonly isExternalPlayerSupported?: () => boolean;
  readonly launchExternalPlayer?: (
    req: ExternalPlayerRequest,
  ) => Promise<ExternalPlayerResult | null | undefined>;
}

/** Minimal Linking surface injected for unit testing (`#406`). */
interface ExternalPlayerLinkingLike {
  canOpenURL(url: string): Promise<boolean>;
  openURL(url: string): Promise<unknown>;
}

/** Options for {@link createMobileExternalPlayerPort}. */
export interface CreateMobileExternalPlayerPortOptions {
  readonly os?: string;
  readonly isTV?: boolean;
  readonly linking?: ExternalPlayerLinkingLike;
  readonly media3Bridge?: Media3ExternalPlayerBridge;
}

function isAllowedStreamUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!HTTP_STREAM_URL_RE.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Builds a safe iOS URL-scheme handoff URI for an external player (`#406`), or `null` when URL/scheme is disallowed. */
export function buildIosExternalPlayerUrl(streamUrl: string, customScheme?: string): string | null {
  const trimmedUrl = streamUrl.trim();
  if (!isAllowedStreamUrl(trimmedUrl)) {
    return null;
  }
  const scheme = normalizeExternalPlayerScheme(customScheme, '');
  if (scheme.length === 0) {
    return null;
  }
  const encodedUrl = encodeURIComponent(trimmedUrl);
  const encodedReturn = encodeURIComponent(EXTERNAL_RETURN_URL);
  if (scheme === 'vlc-x-callback') {
    return `vlc-x-callback://x-callback-url/stream?url=${encodedUrl}&x-success=${encodedReturn}`;
  }
  if (scheme === 'infuse') {
    return `infuse://x-callback-url/play?url=${encodedUrl}&x-success=${encodedReturn}`;
  }
  if (scheme === 'outplayer') {
    return `outplayer://${trimmedUrl}`;
  }
  if (scheme === 'nplayer-http' || scheme === 'nplayer-https') {
    return `${scheme}://${trimmedUrl.replace(/^https?:\/\//i, '')}`;
  }
  return `${scheme}://${encodedUrl}`;
}

/**
 * Creates the mobile platform {@link ExternalPlayerPort} (`#406`):
 * - Android: delegates to `@elv/engine-media3`'s native `launchExternalPlayer` (`ACTION_VIEW` + result).
 * - iOS (handheld): opens a validated URL-scheme handoff via `Linking.openURL`.
 * - tvOS / unsupported platforms: reports `isSupported: false`.
 */
export function createMobileExternalPlayerPort(
  options: CreateMobileExternalPlayerPortOptions = {},
): ExternalPlayerPort {
  const os = options.os ?? Platform.OS;
  const isTV = options.isTV ?? Platform.isTV;
  const linking: ExternalPlayerLinkingLike = options.linking ?? Linking;
  const bridge: Media3ExternalPlayerBridge =
    options.media3Bridge ?? (media3 as unknown as Media3ExternalPlayerBridge);

  if (os === 'android') {
    const nativeSupported =
      typeof bridge.isExternalPlayerSupported === 'function'
        ? bridge.isExternalPlayerSupported()
        : typeof bridge.launchExternalPlayer === 'function';
    return {
      isSupported: nativeSupported,
      async launch(req: ExternalPlayerRequest): Promise<ExternalPlayerResult> {
        if (typeof bridge.launchExternalPlayer !== 'function') {
          return { launched: false, errorCode: 'unsupported' };
        }
        try {
          const result = await bridge.launchExternalPlayer(req);
          if (result == null) {
            return { launched: false, errorCode: 'launch_failed' };
          }
          return result;
        } catch {
          return { launched: false, errorCode: 'launch_failed' };
        }
      },
    };
  }

  if (os === 'ios' && !isTV) {
    return {
      isSupported: true,
      async launch(req: ExternalPlayerRequest): Promise<ExternalPlayerResult> {
        const trimmedUrl = req.url.trim();
        if (!isAllowedStreamUrl(trimmedUrl)) {
          return { launched: false, errorCode: 'invalid_url' };
        }
        const rawScheme = req.customScheme?.trim() ?? '';
        if (rawScheme.length > 0) {
          const targetUrl = buildIosExternalPlayerUrl(trimmedUrl, rawScheme);
          if (targetUrl === null) {
            return { launched: false, errorCode: 'invalid_scheme' };
          }
          try {
            const canOpen = await linking.canOpenURL(targetUrl);
            if (!canOpen) {
              return { launched: false, errorCode: 'cannot_open_url' };
            }
            await linking.openURL(targetUrl);
            return { launched: true };
          } catch {
            return { launched: false, errorCode: 'launch_failed' };
          }
        }

        const nplayerScheme = trimmedUrl.toLowerCase().startsWith('https://')
          ? 'nplayer-https'
          : 'nplayer-http';
        const candidates = ['vlc-x-callback', 'infuse', 'outplayer', nplayerScheme] as const;
        for (const candidate of candidates) {
          const candidateUrl = buildIosExternalPlayerUrl(trimmedUrl, candidate);
          if (candidateUrl === null) continue;
          let canOpen = false;
          try {
            canOpen = await linking.canOpenURL(candidateUrl);
          } catch {
            canOpen = false;
          }
          if (canOpen) {
            try {
              await linking.openURL(candidateUrl);
              return { launched: true };
            } catch {
              return { launched: false, errorCode: 'launch_failed' };
            }
          }
        }
        return { launched: false, errorCode: 'no_player_available' };
      },
    };
  }

  return {
    isSupported: false,
    async launch(): Promise<ExternalPlayerResult> {
      return { launched: false, errorCode: 'unsupported' };
    },
  };
}
