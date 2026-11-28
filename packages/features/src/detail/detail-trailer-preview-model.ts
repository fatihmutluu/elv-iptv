import { isValidTrailerStreamUrl, isValidYoutubeId } from './detail-trailer-utils';

/** Initial settle delay (ms) before preloading background hero trailer assets (`UI_UX_PHILOSOPHY.md` §3). */
export const DETAIL_TRAILER_PRELOAD_DELAY_MS = 400;

/** Idle dwell delay (ms) before revealing and auto-playing the hero trailer preview. */
export const DETAIL_TRAILER_AUTOPLAY_DELAY_MS = 2500;

/** Canonical origin for privacy-enhanced YouTube trailer embeds and `postMessage` commands. */
export const YOUTUBE_NOCOOKIE_ORIGIN = 'https://www.youtube-nocookie.com';

/** Lifecycle phase of {@link DetailHeroTrailerPreview}. */
export type TrailerPreviewPhase = 'idle' | 'preloading' | 'playing';

/** Supported YouTube IFrame API `command` function names. */
export type YoutubeIframeCommandFunc = 'mute' | 'unMute' | 'playVideo' | 'pauseVideo';

/** Resolved background hero trailer playback strategy. */
export type HeroTrailerSource =
  | { readonly kind: 'none' }
  | { readonly kind: 'html-video'; readonly url: string }
  | {
      readonly kind: 'youtube-iframe';
      readonly youtubeId: string;
      readonly embedUrl: string;
    };

/** Input to {@link resolveHeroTrailerSource}. */
export interface ResolveHeroTrailerSourceInput {
  readonly trailerStreamUrl: string | null | undefined;
  readonly trailerYoutubeId: string | null | undefined;
  readonly platformOs: string;
  readonly isTv: boolean;
  readonly reduceMotion: boolean;
}

/**
 * Resolves the background hero trailer preview source for the current platform and accessibility settings:
 * - Returns `{ kind: 'none' }` when `reduceMotion` is enabled, on TV (`isTv`), on non-web platforms,
 *   or when neither a valid HTTPS stream URL nor a valid 11-character YouTube ID is available.
 * - On Desktop/Web (`platformOs === 'web'`), prioritizes validated `trailerStreamUrl` (`html-video`)
 *   before falling back to a privacy-enhanced `youtube-nocookie.com` iframe with `enablejsapi=1`.
 */
export function resolveHeroTrailerSource(input: ResolveHeroTrailerSourceInput): HeroTrailerSource {
  if (input.reduceMotion || input.isTv || input.platformOs !== 'web') {
    return { kind: 'none' };
  }
  if (isValidTrailerStreamUrl(input.trailerStreamUrl)) {
    return { kind: 'html-video', url: input.trailerStreamUrl.trim() };
  }
  if (isValidYoutubeId(input.trailerYoutubeId)) {
    const youtubeId = input.trailerYoutubeId.trim();
    return {
      kind: 'youtube-iframe',
      youtubeId,
      embedUrl:
        `${YOUTUBE_NOCOOKIE_ORIGIN}/embed/${youtubeId}` +
        `?autoplay=1&mute=1&controls=0&rel=0&playsinline=1&modestbranding=1&iv_load_policy=3&disablekb=1&fs=0&loop=1&playlist=${youtubeId}&enablejsapi=1`,
    };
  }
  return { kind: 'none' };
}

/** Builds a serialized YouTube IFrame Player API `postMessage` command payload. */
export function buildYoutubeCommand(func: YoutubeIframeCommandFunc): string {
  return JSON.stringify({ event: 'command', func, args: [] });
}

/** Builds a YouTube IFrame Player API `mute` or `unMute` `postMessage` payload. */
export function buildYoutubeMuteCommand(muted: boolean): string {
  return buildYoutubeCommand(muted ? 'mute' : 'unMute');
}

/** Builds the YouTube IFrame Player API `listening` handshake payload to subscribe to player events. */
export function buildYoutubeListeningHandshake(): string {
  return JSON.stringify({ event: 'listening' });
}

/** Extracts `'onReady'` or `'infoDelivery'` from a YouTube IFrame `postMessage` payload, or `null`. */
export function parseYoutubePlayerMessageEvent(data: unknown): 'onReady' | 'infoDelivery' | null {
  let parsed: unknown = data;
  if (typeof data === 'string') {
    if (data.length === 0 || data.length > 16_384) return null;
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const event = (parsed as { readonly event?: unknown }).event;
  return event === 'onReady' || event === 'infoDelivery' ? event : null;
}
