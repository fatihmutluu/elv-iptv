import { normalizeExternalPlayerScheme } from '@elv/domain';
import * as media3 from '@elv/engine-media3';
import type {
  ExternalPlayerPort,
  ExternalPlayerRequest,
  ExternalPlayerResult,
} from '@elv/features';
import { Linking, Platform } from 'react-native';

const EXTERNAL_RETURN_URL = 'elviptv://external-return';

interface Media3ExternalPlayerBridge {
  readonly isExternalPlayerSupported?: () => boolean;
  readonly launchExternalPlayer?: (req: ExternalPlayerRequest) => Promise<ExternalPlayerResult>;
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

/** Builds a safe iOS URL-scheme handoff URI for an external player (`#406`). */
export function buildIosExternalPlayerUrl(streamUrl: string, customScheme?: string): string {
  const scheme = normalizeExternalPlayerScheme(customScheme, '');
  const encodedUrl = encodeURIComponent(streamUrl);
  const encodedReturn = encodeURIComponent(EXTERNAL_RETURN_URL);
  if (scheme.length === 0) {
    return streamUrl;
  }
  if (scheme === 'vlc-x-callback') {
    return `vlc-x-callback://x-callback-url/stream?url=${encodedUrl}&x-success=${encodedReturn}`;
  }
  if (scheme === 'infuse') {
    return `infuse://x-callback-url/play?url=${encodedUrl}&x-success=${encodedReturn}`;
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
          return await bridge.launchExternalPlayer(req);
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
        const targetUrl = buildIosExternalPlayerUrl(req.url, req.customScheme);
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
