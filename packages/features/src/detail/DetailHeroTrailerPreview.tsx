import { IconButton, useI18n, useTheme, webTransition } from '@elv/ui-kit';
import {
  createElement,
  memo,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useDocumentVisible } from '../shared/useRouteActive';
import {
  buildYoutubeCommand,
  buildYoutubeListeningHandshake,
  DETAIL_TRAILER_AUTOPLAY_DELAY_MS,
  DETAIL_TRAILER_PRELOAD_DELAY_MS,
  parseYoutubePlayerMessageEvent,
  resolveHeroTrailerSource,
  type TrailerPreviewPhase,
  YOUTUBE_NOCOOKIE_ORIGIN,
  type YoutubeIframeCommandFunc,
} from './detail-trailer-preview-model';

const YOUTUBE_RETRY_DELAYS_MS = [400, 1000] as const;

/** Props of {@link DetailHeroTrailerPreview}. */
export interface DetailHeroTrailerPreviewProps {
  readonly titleKey: string;
  readonly trailerStreamUrl: string | null;
  readonly trailerYoutubeId: string | null;
  readonly muted: boolean;
  readonly active: boolean;
  readonly topOffset: number;
  readonly rightOffset: number;
  readonly isTv: boolean;
  readonly hideMuteButton?: boolean;
  readonly onPlayingChange?: (playing: boolean) => void;
  readonly onToggleMuted: () => void;
}

interface HtmlVideoElementLike {
  muted: boolean;
  play?(): Promise<void> | undefined;
  pause?(): void;
}

interface HtmlIframeElementLike {
  readonly contentWindow?: {
    postMessage?(message: string, targetOrigin: string): void;
  } | null;
}

interface PreconnectLinkLike {
  rel: string;
  href: string;
  setAttribute?(name: string, value: string): void;
  remove?(): void;
}

interface PreconnectDocumentLike {
  readonly visibilityState?: string;
  readonly head?: {
    appendChild?(node: PreconnectLinkLike): unknown;
    removeChild?(node: PreconnectLinkLike): unknown;
  } | null;
  createElement?(tag: string): PreconnectLinkLike;
}

interface MessageEventLike {
  readonly origin?: string;
  readonly data?: unknown;
}

interface MessageWindowLike {
  addEventListener?(type: string, listener: (event: MessageEventLike) => void): void;
  removeEventListener?(type: string, listener: (event: MessageEventLike) => void): void;
}

function getWebDocument(): PreconnectDocumentLike | undefined {
  return (globalThis as { document?: PreconnectDocumentLike }).document;
}

function getWebWindow(): MessageWindowLike | undefined {
  return (globalThis as { window?: MessageWindowLike }).window;
}

/**
 * Background hero trailer preload and idle auto-play layer (`Cinema Quietude v3` Wave R2).
 * Settles `400ms` before preloading (`<video preload="auto" paused>` or YouTube preconnect) and
 * begins muted/preference-synced playback after `2500ms` idle dwell with an optional top-right
 * circular Mute/Unmute toggle (`testID="detail-trailer-mute-toggle"`). Immediately resets to `'idle'`
 * on `titleKey` changes, `active=false`, stream errors, or hidden document visibility.
 */
export const DetailHeroTrailerPreview = memo(function DetailHeroTrailerPreviewInner({
  titleKey,
  trailerStreamUrl,
  trailerYoutubeId,
  muted,
  active,
  topOffset,
  rightOffset,
  isTv,
  hideMuteButton = false,
  onPlayingChange,
  onToggleMuted,
}: DetailHeroTrailerPreviewProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const docVisible = useDocumentVisible();

  const source = useMemo(
    () =>
      resolveHeroTrailerSource({
        trailerStreamUrl,
        trailerYoutubeId,
        platformOs: Platform.OS,
        isTv,
        reduceMotion: theme.reduceMotion,
      }),
    [isTv, theme.reduceMotion, trailerStreamUrl, trailerYoutubeId],
  );

  const sourceKey =
    source.kind === 'html-video'
      ? `video:${source.url}`
      : source.kind === 'youtube-iframe'
        ? `yt:${source.youtubeId}`
        : 'none';
  const instanceKey = `${titleKey}\0${sourceKey}`;

  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [phaseState, setPhaseState] = useState<{
    readonly key: string;
    readonly phase: TrailerPreviewPhase;
  }>({ key: instanceKey, phase: 'idle' });

  const eligible = active && docVisible && source.kind !== 'none' && failedKey !== instanceKey;
  const phase: TrailerPreviewPhase =
    eligible && phaseState.key === instanceKey ? phaseState.phase : 'idle';
  const isPlaying = phase === 'playing';

  const videoRef = useRef<HtmlVideoElementLike | null>(null);
  const iframeRef = useRef<HtmlIframeElementLike | null>(null);
  const iframeLoadedRef = useRef(false);
  const infoDeliveryHandledRef = useRef(false);
  const retryTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const onPlayingChangeRef = useRef(onPlayingChange);
  onPlayingChangeRef.current = onPlayingChange;
  const lastReportedPlayingRef = useRef(false);

  const clearYoutubeRetryTimers = useCallback(() => {
    for (const timer of retryTimersRef.current) {
      clearTimeout(timer);
    }
    retryTimersRef.current = [];
  }, []);

  const postToYoutubeIframe = useCallback((payload: string) => {
    const win = iframeRef.current?.contentWindow;
    if (!win || typeof win.postMessage !== 'function') return;
    win.postMessage(payload, YOUTUBE_NOCOOKIE_ORIGIN);
  }, []);

  const sendYoutubeCommand = useCallback(
    (func: YoutubeIframeCommandFunc) => {
      postToYoutubeIframe(buildYoutubeCommand(func));
    },
    [postToYoutubeIframe],
  );

  useEffect(() => {
    if (lastReportedPlayingRef.current === isPlaying) return;
    lastReportedPlayingRef.current = isPlaying;
    onPlayingChangeRef.current?.(isPlaying);
  }, [isPlaying]);

  useEffect(() => {
    return () => {
      if (lastReportedPlayingRef.current) {
        lastReportedPlayingRef.current = false;
        onPlayingChangeRef.current?.(false);
      }
    };
  }, []);

  useEffect(() => {
    if (!eligible) {
      setPhaseState((cur) =>
        cur.key === instanceKey && cur.phase === 'idle' ? cur : { key: instanceKey, phase: 'idle' },
      );
      return undefined;
    }

    setPhaseState({ key: instanceKey, phase: 'idle' });
    const preloadTimer = setTimeout(() => {
      setPhaseState({ key: instanceKey, phase: 'preloading' });
    }, DETAIL_TRAILER_PRELOAD_DELAY_MS);
    const playTimer = setTimeout(() => {
      if (getWebDocument()?.visibilityState === 'hidden') return;
      setPhaseState({ key: instanceKey, phase: 'playing' });
    }, DETAIL_TRAILER_AUTOPLAY_DELAY_MS);

    return () => {
      clearTimeout(preloadTimer);
      clearTimeout(playTimer);
    };
  }, [eligible, instanceKey]);

  const shouldPreconnectYoutube =
    source.kind === 'youtube-iframe' && (phase === 'preloading' || phase === 'playing');

  useEffect(() => {
    if (!shouldPreconnectYoutube) return undefined;
    const doc = getWebDocument();
    if (!doc?.head?.appendChild || typeof doc.createElement !== 'function') return undefined;
    const link = doc.createElement('link');
    link.rel = 'preconnect';
    link.href = YOUTUBE_NOCOOKIE_ORIGIN;
    link.setAttribute?.('data-elv-trailer-preconnect', 'youtube-nocookie');
    doc.head.appendChild(link);
    return () => {
      if (typeof link.remove === 'function') {
        link.remove();
      } else {
        doc.head?.removeChild?.(link);
      }
    };
  }, [shouldPreconnectYoutube]);

  useEffect(() => {
    if (source.kind === 'html-video' && videoRef.current) {
      videoRef.current.muted = muted;
    }
  }, [muted, source.kind]);

  useEffect(() => {
    if (source.kind !== 'html-video') return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    video.muted = mutedRef.current;
    if (phase === 'playing') {
      let cancelled = false;
      const res = video.play?.();
      if (res && typeof res.catch === 'function') {
        void res.catch(() => {
          if (cancelled || mutedRef.current) return;
          video.muted = true;
          const retry = video.play?.();
          if (retry && typeof retry.catch === 'function') {
            void retry.catch(() => undefined);
          }
        });
      }
      return () => {
        cancelled = true;
        video.pause?.();
      };
    }
    if (phase === 'preloading') {
      video.pause?.();
    }
    return undefined;
  }, [phase, source.kind]);

  useEffect(() => {
    if (phase !== 'playing' || source.kind !== 'youtube-iframe') {
      iframeLoadedRef.current = false;
      infoDeliveryHandledRef.current = false;
      clearYoutubeRetryTimers();
      return undefined;
    }

    const win = getWebWindow();
    if (!win?.addEventListener || !win.removeEventListener) {
      return () => {
        clearYoutubeRetryTimers();
      };
    }

    const handleMessage = (event: MessageEventLike) => {
      if (event.origin !== YOUTUBE_NOCOOKIE_ORIGIN) return;
      const playerEvent = parseYoutubePlayerMessageEvent(event.data);
      if (playerEvent === null) return;
      if (playerEvent === 'onReady') {
        clearYoutubeRetryTimers();
        sendYoutubeCommand(mutedRef.current ? 'mute' : 'unMute');
        return;
      }
      if (!infoDeliveryHandledRef.current) {
        infoDeliveryHandledRef.current = true;
        sendYoutubeCommand(mutedRef.current ? 'mute' : 'unMute');
      }
    };

    win.addEventListener('message', handleMessage);
    return () => {
      win.removeEventListener?.('message', handleMessage);
      clearYoutubeRetryTimers();
    };
  }, [clearYoutubeRetryTimers, phase, sendYoutubeCommand, source.kind]);

  useEffect(() => {
    if (phase === 'playing' && source.kind === 'youtube-iframe' && iframeLoadedRef.current) {
      sendYoutubeCommand(muted ? 'mute' : 'unMute');
    }
  }, [muted, phase, sendYoutubeCommand, source.kind]);

  const handleIframeLoad = useCallback(
    (event?: { readonly currentTarget?: HtmlIframeElementLike | null }) => {
      if (!iframeRef.current?.contentWindow && event?.currentTarget?.contentWindow) {
        iframeRef.current = event.currentTarget;
      }
      iframeLoadedRef.current = true;
      infoDeliveryHandledRef.current = false;
      clearYoutubeRetryTimers();
      postToYoutubeIframe(buildYoutubeListeningHandshake());
      sendYoutubeCommand(mutedRef.current ? 'mute' : 'unMute');

      retryTimersRef.current = YOUTUBE_RETRY_DELAYS_MS.map((delayMs) =>
        setTimeout(() => {
          postToYoutubeIframe(buildYoutubeListeningHandshake());
          sendYoutubeCommand(mutedRef.current ? 'mute' : 'unMute');
        }, delayMs),
      );
    },
    [clearYoutubeRetryTimers, postToYoutubeIframe, sendYoutubeCommand],
  );

  const handleVideoError = useCallback(() => {
    setFailedKey(instanceKey);
  }, [instanceKey]);

  if (source.kind === 'none' || phase === 'idle') {
    return null;
  }

  const shouldRenderMedia = source.kind === 'html-video' || isPlaying;
  const fadeTransition = webTransition(theme, 'opacity');
  const muteLabel = muted ? i18n.t('detail.trailer.unmute') : i18n.t('detail.trailer.mute');

  return (
    <View pointerEvents="box-none" testID="detail-trailer-preview" style={StyleSheet.absoluteFill}>
      {shouldRenderMedia ? (
        <View
          pointerEvents="none"
          testID="detail-trailer-preview-media"
          style={[
            StyleSheet.absoluteFill,
            styles.mediaLayer,
            fadeTransition,
            { opacity: isPlaying ? 1 : 0 },
          ]}
        >
          {source.kind === 'html-video'
            ? createElement('video', {
                key: instanceKey,
                ref: videoRef,
                'data-testid': 'detail-trailer-preview-video',
                src: source.url,
                autoPlay: isPlaying,
                loop: true,
                playsInline: true,
                preload: 'auto',
                muted,
                controls: false,
                disablePictureInPicture: true,
                'aria-hidden': true,
                tabIndex: -1,
                onError: handleVideoError,
                style: HTML_VIDEO_STYLE,
              })
            : createElement('iframe', {
                key: instanceKey,
                ref: iframeRef,
                'data-testid': 'detail-trailer-preview-iframe',
                title: titleKey,
                src: source.embedUrl,
                sandbox: 'allow-scripts allow-same-origin allow-presentation',
                allow: 'autoplay; encrypted-media',
                referrerPolicy: 'strict-origin-when-cross-origin',
                tabIndex: -1,
                'aria-hidden': true,
                onLoad: handleIframeLoad,
                style: YOUTUBE_IFRAME_STYLE,
              })}
        </View>
      ) : null}

      {isPlaying && !hideMuteButton ? (
        <View
          pointerEvents="box-none"
          testID="detail-trailer-mute-anchor"
          style={[
            styles.muteAnchor,
            {
              top: topOffset,
              right: rightOffset,
            },
          ]}
        >
          <IconButton
            testID="detail-trailer-mute-toggle"
            icon={muted ? 'volumeMute' : 'audio'}
            size={44}
            accessibilityLabel={muteLabel}
            focusable={!isTv}
            onPress={onToggleMuted}
          />
        </View>
      ) : null}
    </View>
  );
});

DetailHeroTrailerPreview.displayName = 'DetailHeroTrailerPreview';

const HTML_VIDEO_STYLE = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
  pointerEvents: 'none',
} as const;

const YOUTUBE_IFRAME_STYLE = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  width: '100%',
  height: '100%',
  minWidth: '136vh',
  minHeight: '56.25vw',
  transform: 'translate(-50%, -50%) scale(1.12)',
  border: 'none',
  display: 'block',
  pointerEvents: 'none',
} as const;

const styles = StyleSheet.create({
  mediaLayer: {
    overflow: 'hidden',
    zIndex: 0,
  },
  muteAnchor: {
    position: 'absolute',
    zIndex: 6,
  },
});
