import type { KeyEvent } from '@elv/focus-core';
import {
  CtaButton,
  hexToRgba,
  Icon,
  TvFocusAnchor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
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
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { TrailerExternalPort } from '../ports/trailer-port';
import type { OpenVideoEngine, VideoHost } from '../ports/video-host';
import { resolveTrailerPlaybackStrategy } from './detail-trailer-utils';

/** Props of {@link DetailTrailerModal}. */
export interface DetailTrailerModalProps {
  readonly visible: boolean;
  readonly title: string;
  readonly trailerStreamUrl: string | null;
  readonly trailerYoutubeId: string | null;
  readonly videoHost?: VideoHost;
  readonly trailerExternal?: TrailerExternalPort;
  readonly onClose: () => void;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function TrailerTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: (event: KeyEvent) => boolean;
}): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="detail-trailer-tv-anchor" hasTVPreferredFocus />;
}

/**
 * In-app Cinema Quietude trailer modal (`#512`):
 * - Priority 1: Direct IMDb MP4/HLS HTTPS stream inside our native `VideoHost` (zero `watch_history` writes, works on TV/Desktop/Mobile incl. tvOS).
 * - Priority 2: Validated 11-char YouTube ID -> Desktop/Web sandboxed `youtube-nocookie.com` iframe + `"Open in YouTube"`, or native external handoff via {@link TrailerExternalPort}.
 * - Zero RN `<Modal>` and HWND-safe docked layout when `opened.overlayMode === 'docked'`.
 */
export const DetailTrailerModal = memo(function DetailTrailerModalInner({
  visible,
  title,
  trailerStreamUrl,
  trailerYoutubeId,
  videoHost,
  trailerExternal,
  onClose,
}: DetailTrailerModalProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';

  const baseStrategy = useMemo(
    () =>
      resolveTrailerPlaybackStrategy({
        trailerStreamUrl,
        trailerYoutubeId,
        formFactor: viewport.formFactor,
        platformOs: Platform.OS,
        hasVideoHost: videoHost !== undefined,
      }),
    [trailerStreamUrl, trailerYoutubeId, videoHost, viewport.formFactor],
  );
  const fallbackYoutubeStrategy = useMemo(
    () =>
      resolveTrailerPlaybackStrategy({
        trailerStreamUrl: null,
        trailerYoutubeId,
        formFactor: viewport.formFactor,
        platformOs: Platform.OS,
        hasVideoHost: false,
      }),
    [trailerYoutubeId, viewport.formFactor],
  );
  const nativeStreamUrl = baseStrategy.kind === 'native-stream' ? baseStrategy.url : null;

  const [openedEngine, setOpenedEngine] = useState<OpenVideoEngine | null>(null);
  const [overlayMode, setOverlayMode] = useState<'floating' | 'docked'>('floating');
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [streamFailed, setStreamFailed] = useState(false);
  const [loadingStream, setLoadingStream] = useState(false);
  const [externalError, setExternalError] = useState(false);
  const openedRef = useRef<OpenVideoEngine | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const strategy =
    baseStrategy.kind === 'native-stream' &&
    streamFailed &&
    fallbackYoutubeStrategy.kind !== 'unavailable'
      ? fallbackYoutubeStrategy
      : baseStrategy;

  useEffect(() => {
    if (!visible) {
      setExternalError(false);
      setStreamFailed(false);
      setOverlayMode('floating');
      setPaused(false);
      setMuted(false);
      return undefined;
    }

    if (nativeStreamUrl === null || videoHost === undefined) {
      setOpenedEngine(null);
      setOverlayMode('floating');
      setLoadingStream(false);
      return undefined;
    }

    let cancelled = false;
    let activeOpened: OpenVideoEngine | null = null;
    let unsubEvents: (() => void) | undefined;
    let unsubHostKey: (() => void) | undefined;
    let unsubOverlayMode: (() => void) | undefined;
    setLoadingStream(true);
    setStreamFailed(false);
    setOverlayMode('floating');
    setPaused(false);

    const releaseActive = () => {
      unsubEvents?.();
      unsubEvents = undefined;
      unsubHostKey?.();
      unsubHostKey = undefined;
      unsubOverlayMode?.();
      unsubOverlayMode = undefined;
      if (activeOpened !== null) {
        try {
          activeOpened.engine.stop(1);
        } catch {
          // Best-effort cleanup on close or stream failure.
        }
        try {
          activeOpened.engine.release();
        } catch {
          // Best-effort cleanup on close or stream failure.
        }
        activeOpened = null;
      }
      openedRef.current = null;
      setOpenedEngine(null);
    };

    const attach = (opened: OpenVideoEngine | null) => {
      if (cancelled) {
        opened?.engine.release();
        return;
      }
      if (opened === null) {
        setLoadingStream(false);
        setStreamFailed(true);
        return;
      }
      activeOpened = opened;
      openedRef.current = opened;
      setOpenedEngine(opened);
      setOverlayMode(opened.overlayMode ?? 'floating');
      unsubOverlayMode = opened.onOverlayModeChange?.((mode) => {
        if (!cancelled) setOverlayMode(mode);
      });
      unsubEvents = opened.engine.subscribe((ev) => {
        if (cancelled) return;
        if (ev.type === 'state') {
          if (ev.state === 'playing') {
            setLoadingStream(false);
            setPaused(false);
          } else if (ev.state === 'paused') {
            setPaused(true);
          } else if (ev.state === 'ended') {
            setPaused(true);
          }
        } else if (ev.type === 'firstFrame') {
          setLoadingStream(false);
        } else if (ev.type === 'error') {
          setLoadingStream(false);
          releaseActive();
          setStreamFailed(true);
        }
      });
      unsubHostKey = opened.onHostKey?.((key) => {
        if (key === 'back' || key === 'stop' || (key as string) === 'close') {
          onCloseRef.current();
        }
      });
      opened.engine.load({
        attempt: 1,
        kind: 'vod',
        url: nativeStreamUrl,
        headers: {},
      });
    };

    try {
      const openedOrPromise = videoHost.open({ primary: true });
      if (isPromiseLike(openedOrPromise)) {
        void openedOrPromise.then(attach, () => {
          if (!cancelled) {
            setLoadingStream(false);
            setStreamFailed(true);
          }
        });
      } else {
        attach(openedOrPromise);
      }
    } catch {
      setLoadingStream(false);
      setStreamFailed(true);
    }

    return () => {
      cancelled = true;
      releaseActive();
    };
  }, [nativeStreamUrl, videoHost, visible]);

  useEffect(() => {
    if (!visible || Platform.OS !== 'web') return undefined;
    const win = (
      globalThis as {
        window?: {
          addEventListener?: (type: string, fn: (ev: unknown) => void) => void;
          removeEventListener?: (type: string, fn: (ev: unknown) => void) => void;
        };
      }
    ).window;
    if (typeof win?.addEventListener !== 'function') return undefined;
    const onKeyDown = (ev: unknown) => {
      const key = (ev as { key?: string } | null)?.key;
      if (key === 'Escape') onCloseRef.current();
    };
    win.addEventListener('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [visible]);

  const handleTogglePlayPause = useCallback(() => {
    const opened = openedRef.current;
    if (!opened) return;
    if (paused) {
      opened.engine.play(1);
      setPaused(false);
    } else {
      opened.engine.pause(1);
      setPaused(true);
    }
  }, [paused]);

  const handleToggleMute = useCallback(() => {
    const opened = openedRef.current;
    if (!opened?.toggleMute) return;
    opened.toggleMute();
    setMuted((m) => !m);
  }, []);

  const handleOpenExternal = useCallback(
    (watchUrl: string) => {
      if (!trailerExternal) {
        setExternalError(true);
        return;
      }
      void trailerExternal
        .openExternalUrl(watchUrl)
        .then((ok) => {
          if (!ok) setExternalError(true);
        })
        .catch(() => setExternalError(true));
    },
    [trailerExternal],
  );

  const watchUrl =
    strategy.kind === 'web-iframe' ||
    strategy.kind === 'external-youtube' ||
    strategy.kind === 'mobile-external'
      ? strategy.watchUrl
      : null;

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind !== 'press') return true;
      if (event.key === 'back') {
        onCloseRef.current();
        return true;
      }
      if (event.key === 'playPause' || event.key === 'select') {
        if (strategy.kind === 'native-stream' && !streamFailed && openedRef.current !== null) {
          handleTogglePlayPause();
        } else if (event.key === 'select' && watchUrl !== null) {
          handleOpenExternal(watchUrl);
        } else {
          onCloseRef.current();
        }
        return true;
      }
      return true;
    },
    [handleOpenExternal, handleTogglePlayPause, strategy.kind, streamFailed, watchUrl],
  );

  if (!visible) return null;

  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, opacity, transform');
  const stageWidth = Math.min(960, Math.max(300, viewport.width - 48));
  const stageHeight = Math.min(
    Math.round((stageWidth * 9) / 16),
    Math.max(220, viewport.height - 160),
  );

  return (
    <View testID="detail-trailer-modal" accessibilityViewIsModal style={styles.overlayRoot}>
      {isTv ? <TrailerTvKeyBridge onEvent={handleTvKey} /> : null}
      <Pressable
        testID="detail-trailer-backdrop"
        accessibilityRole="button"
        accessibilityLabel={i18n.t('detail.trailer.close')}
        focusable={false}
        onPress={onClose}
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: hexToRgba(theme.colors.bgCanvas, 0.86) },
        ]}
      />
      <View pointerEvents="box-none" style={styles.center}>
        <View
          style={[
            styles.dialog,
            webBackdropBlur(20),
            {
              width: stageWidth,
              backgroundColor: theme.colors.bgElevated,
              borderColor: theme.colors.surfaceBorder,
              borderRadius: theme.radius.modal,
            },
          ]}
        >
          <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
            <View style={styles.titleBlock}>
              <Text
                numberOfLines={1}
                style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
              >
                {`${title} · ${i18n.t('detail.trailer.title')}`}
              </Text>
            </View>
            <Pressable
              testID="detail-trailer-close"
              accessibilityRole="button"
              accessibilityLabel={i18n.t('detail.trailer.close')}
              focusable={!isTv}
              onPress={onClose}
              style={({ pressed }) => [
                styles.iconBtn,
                cursor,
                transition,
                {
                  borderRadius: theme.radius.pill,
                  backgroundColor: theme.colors.actionGlassBg,
                  borderColor: theme.colors.actionGlassBorder,
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              <Icon name="close" size={18} color={theme.colors.textPrimary} />
            </Pressable>
          </View>

          <View
            testID="detail-trailer-stage"
            style={[styles.stage, { height: stageHeight, backgroundColor: theme.colors.bgCanvas }]}
          >
            {strategy.kind === 'native-stream' ? (
              streamFailed ? (
                <View testID="detail-trailer-unavailable" style={styles.messageBox}>
                  <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                    {i18n.t('detail.trailer.unavailable')}
                  </Text>
                </View>
              ) : (
                <View style={styles.nativeContainer}>
                  <View style={styles.surfaceFlex}>
                    {openedEngine !== null
                      ? openedEngine.renderSurface({
                          statusText: `${title} — ${i18n.t('detail.trailer.title')}`,
                          failed: streamFailed,
                          resizeMode: 'fit',
                          testID: 'detail-trailer-surface',
                        })
                      : null}
                    {loadingStream && overlayMode !== 'docked' ? (
                      <View
                        testID="detail-trailer-loading-overlay"
                        pointerEvents="none"
                        style={styles.loadingOverlay}
                      >
                        <ActivityIndicator size="large" color={theme.colors.textPrimary} />
                      </View>
                    ) : null}
                  </View>
                  <View
                    testID="detail-trailer-controls"
                    style={[
                      styles.controlsBar,
                      {
                        backgroundColor: theme.colors.bgSurface,
                        borderTopColor: theme.colors.surfaceBorder,
                      },
                    ]}
                  >
                    <Pressable
                      testID="detail-trailer-play-pause"
                      accessibilityRole="button"
                      accessibilityLabel={paused ? i18n.t('player.play') : i18n.t('player.pause')}
                      focusable={!isTv}
                      onPress={handleTogglePlayPause}
                      style={[
                        styles.iconBtn,
                        cursor,
                        {
                          borderRadius: theme.radius.pill,
                          backgroundColor: theme.colors.actionGlassBg,
                          borderColor: theme.colors.actionGlassBorder,
                        },
                      ]}
                    >
                      <Icon
                        name={paused ? 'play' : 'pause'}
                        size={18}
                        color={theme.colors.textPrimary}
                      />
                    </Pressable>
                    {openedEngine?.toggleMute !== undefined ? (
                      <Pressable
                        testID="detail-trailer-mute"
                        accessibilityRole="button"
                        accessibilityLabel={muted ? i18n.t('player.unmute') : i18n.t('player.mute')}
                        focusable={!isTv}
                        onPress={handleToggleMute}
                        style={[
                          styles.iconBtn,
                          cursor,
                          {
                            borderRadius: theme.radius.pill,
                            backgroundColor: theme.colors.actionGlassBg,
                            borderColor: theme.colors.actionGlassBorder,
                          },
                        ]}
                      >
                        <Icon
                          name={muted ? 'volumeMute' : 'audio'}
                          size={18}
                          color={theme.colors.textPrimary}
                        />
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              )
            ) : strategy.kind === 'web-iframe' ? (
              <View style={styles.iframeContainer} testID="detail-trailer-iframe-wrap">
                {createElement('iframe', {
                  'data-testid': 'detail-trailer-iframe',
                  title: `${title} — ${i18n.t('detail.trailer.title')}`,
                  src: strategy.embedUrl,
                  sandbox: 'allow-scripts allow-same-origin allow-presentation',
                  allow: 'autoplay; encrypted-media; picture-in-picture',
                  allowFullScreen: true,
                  referrerPolicy: 'strict-origin-when-cross-origin',
                  style: {
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    display: 'block',
                  },
                })}
              </View>
            ) : (
              <View testID="detail-trailer-unavailable" style={styles.messageBox}>
                <Text
                  style={[
                    theme.typography.body,
                    { color: theme.colors.textSecondary, textAlign: 'center' },
                  ]}
                >
                  {externalError || watchUrl === null
                    ? i18n.t('detail.trailer.unavailable')
                    : i18n.t('detail.trailer.openExternal')}
                </Text>
                {watchUrl !== null && trailerExternal !== undefined ? (
                  <View style={styles.externalCtaWrap}>
                    <CtaButton
                      testID="detail-trailer-open-external"
                      variant="primary"
                      icon="play"
                      label={i18n.t('detail.trailer.openExternal')}
                      focusable={!isTv}
                      focused={isTv}
                      onPress={() => handleOpenExternal(watchUrl)}
                    />
                  </View>
                ) : null}
              </View>
            )}
          </View>

          {strategy.kind === 'web-iframe' && watchUrl !== null && trailerExternal !== undefined ? (
            <View style={[styles.footer, { borderTopColor: theme.colors.surfaceBorder }]}>
              {externalError ? (
                <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
                  {i18n.t('detail.trailer.unavailable')}
                </Text>
              ) : null}
              <CtaButton
                testID="detail-trailer-open-external"
                variant="secondary"
                icon="play"
                label={i18n.t('detail.trailer.openExternal')}
                focusable={!isTv}
                onPress={() => handleOpenExternal(watchUrl)}
              />
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
});

DetailTrailerModal.displayName = 'DetailTrailerModal';

const styles = StyleSheet.create({
  overlayRoot: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 65,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  dialog: {
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  stage: {
    width: '100%',
    overflow: 'hidden',
  },
  nativeContainer: {
    flex: 1,
  },
  surfaceFlex: {
    flex: 1,
    position: 'relative',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: 1,
  },
  iframeContainer: {
    flex: 1,
  },
  messageBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  externalCtaWrap: {
    alignItems: 'center',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderTopWidth: 1,
  },
});
