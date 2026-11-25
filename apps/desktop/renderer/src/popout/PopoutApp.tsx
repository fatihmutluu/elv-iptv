import { type CatalogService, createCoalescedCatalog } from '@elv/data';
import {
  AppProviders,
  createLazyCatalog,
  type OpenVideoEngine,
  type VideoHost,
} from '@elv/features';
import { resolveLocale } from '@elv/i18n';
import {
  createPlaybackService,
  type PlaybackService,
  type PlaybackStatus,
  positionAt,
} from '@elv/playback';
import { Icon, type IconName, UiAdaptersProvider, useI18n, useTheme } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { PopoutLaunchPayload, WindowBridge } from '../../../src/shared/window-ipc.ts';
import { createDesktopCatalog } from '../catalog/index.ts';
import { createDesktopVideoHost } from '../player/desktop-video-host.tsx';
import { createDesktopKeymapStore } from '../storage/keymap.ts';
import { createDesktopPreferencesStore } from '../storage/preferences.ts';
import { createDesktopUiAdapters } from '../ui/desktop-adapters.tsx';
import { buildPopoutDockPayload } from './popout-controller.ts';

/** Props of {@link PopoutPlayerStage}. */
export interface PopoutPlayerStageProps {
  readonly catalog: CatalogService;
  readonly videoHost: VideoHost;
  readonly windowBridge: WindowBridge | undefined;
}

const HOVER_HIDE_MS = 2_400;

const DRAG_REGION_STYLE = { WebkitAppRegion: 'drag' } as unknown as ViewStyle;
const NO_DRAG_REGION_STYLE = { WebkitAppRegion: 'no-drag' } as unknown as ViewStyle;

interface CinemaIconButtonProps {
  readonly icon: IconName;
  readonly label: string;
  readonly active?: boolean;
  readonly onPress: () => void;
  readonly testID: string;
}

function CinemaIconButton({
  icon,
  label,
  active = false,
  onPress,
  testID,
}: CinemaIconButtonProps): ReactElement {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={(state) => {
        const isHovered = Boolean((state as { hovered?: boolean }).hovered);
        return [
          styles.iconButton,
          NO_DRAG_REGION_STYLE,
          {
            borderRadius: theme.radius.pill,
            backgroundColor:
              state.pressed || isHovered
                ? theme.colors.actionGlassHoverBg
                : theme.colors.actionGlassBg,
            borderColor: active ? theme.colors.accent : theme.colors.actionGlassBorder,
          },
        ];
      }}
      testID={testID}
    >
      <Icon color={active ? theme.colors.accent : theme.colors.textPrimary} name={icon} size={16} />
    </Pressable>
  );
}

/**
 * Minimalist Cinema Quietude standalone popout player stage (`#158`):
 * unobstructed center video canvas with quiet hover-only top/bottom bars, `max_connections = 1`-safe
 * engine teardown before docking, and zero hardcoded hex colors.
 */
export function PopoutPlayerStage({
  catalog,
  videoHost,
  windowBridge,
}: PopoutPlayerStageProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const [payload, setPayload] = useState<PopoutLaunchPayload | null>(null);
  const [opened, setOpened] = useState<OpenVideoEngine | null>(null);
  const [status, setStatus] = useState<PlaybackStatus>({ kind: 'idle' });
  const [muted, setMuted] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [chromeVisible, setChromeVisible] = useState(true);

  const serviceRef = useRef<PlaybackService | null>(null);
  const openedRef = useRef<OpenVideoEngine | null>(null);
  const payloadRef = useRef<PopoutLaunchPayload | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closingRef = useRef(false);

  payloadRef.current = payload;

  const scheduleHide = useCallback((): void => {
    if (hideTimerRef.current !== undefined) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setChromeVisible(false);
    }, HOVER_HIDE_MS);
  }, []);

  const revealChrome = useCallback((): void => {
    setChromeVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  const releasePlayback = useCallback((): void => {
    const svc = serviceRef.current;
    serviceRef.current = null;
    if (svc) {
      try {
        svc.dispose();
      } catch {
        // ignore dispose errors during teardown
      }
    }
    const eng = openedRef.current;
    openedRef.current = null;
    setOpened(null);
    if (eng) {
      try {
        eng.engine.release();
      } catch {
        // ignore release errors during teardown
      }
    }
  }, []);

  const latestPositionMs = useCallback((): number | undefined => {
    const svc = serviceRef.current;
    if (!svc) return payloadRef.current?.resumePositionMs;
    const snap = svc.getState();
    if (!snap.anchor) return payloadRef.current?.resumePositionMs;
    return positionAt(snap.anchor, performance.now());
  }, []);

  useEffect(() => {
    if (!windowBridge) return;
    let active = true;
    void windowBridge
      .getPopoutPayload()
      .then((initial) => {
        if (active && initial) setPayload(initial);
      })
      .catch(() => undefined);
    void windowBridge
      .getAlwaysOnTop()
      .then((flag) => {
        if (active) setPinned(flag);
      })
      .catch(() => undefined);
    const offPayload = windowBridge.onPopoutPayload((next) => {
      if (active) setPayload(next);
    });
    const offPin = windowBridge.onAlwaysOnTopChanged((flag) => {
      if (active) setPinned(flag);
    });
    return () => {
      active = false;
      offPayload();
      offPin();
    };
  }, [windowBridge]);

  useEffect(() => {
    if (!payload) return;
    let cancelled = false;

    const start = async (): Promise<void> => {
      let currentOpened = openedRef.current;
      let currentService = serviceRef.current;
      if (!currentOpened) {
        currentOpened = await videoHost.open({ replaceExisting: true, primary: true });
        if (cancelled) {
          currentOpened?.engine.release();
          return;
        }
        if (!currentOpened) return;
        openedRef.current = currentOpened;
        setOpened(currentOpened);
        currentService = createPlaybackService({
          engine: currentOpened.engine,
          clock: { now: () => performance.now() },
          timers: {
            setTimeout: (fn, ms) => setTimeout(fn, ms),
            clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
          },
        });
        serviceRef.current = currentService;
        currentService.subscribe((nextState) => {
          if (!cancelled) setStatus(nextState.status);
        });
      }
      if (!currentService || cancelled) return;
      currentService.tune({
        item: payload.itemKey,
        accountKey: payload.sourceId ?? payload.itemKey,
        kind: payload.kind === 'live' ? 'live' : 'vod',
        resolve: () => catalog.resolveStream(payload.itemKey),
        ...(payload.resumePositionMs !== undefined && payload.kind !== 'live'
          ? { startMs: payload.resumePositionMs }
          : {}),
      });
    };

    void start();
    return () => {
      cancelled = true;
    };
  }, [catalog, payload, videoHost]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== undefined) clearTimeout(hideTimerRef.current);
      releasePlayback();
    };
  }, [releasePlayback]);

  const handleTogglePlayPause = useCallback((): void => {
    revealChrome();
    const svc = serviceRef.current;
    if (!svc) return;
    if (status.kind === 'paused') svc.play();
    else svc.pause();
  }, [revealChrome, status.kind]);

  const handleToggleMute = useCallback((): void => {
    revealChrome();
    const nextMuted = !muted;
    setMuted(nextMuted);
    if (openedRef.current?.setMuted) openedRef.current.setMuted(nextMuted);
    else openedRef.current?.toggleMute?.();
  }, [muted, revealChrome]);

  const handleTogglePin = useCallback((): void => {
    revealChrome();
    if (!windowBridge) return;
    void windowBridge
      .setAlwaysOnTop(!pinned)
      .then((actual) => setPinned(actual))
      .catch(() => undefined);
  }, [pinned, revealChrome, windowBridge]);

  const handleDock = useCallback((): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    const current = payloadRef.current;
    const posMs = latestPositionMs();
    // Release popout mpv connection BEFORE notifying main to protect max_connections = 1.
    releasePlayback();
    if (current && windowBridge) {
      void windowBridge.dockPopout(buildPopoutDockPayload(current, posMs)).catch(() => undefined);
    } else {
      void windowBridge?.closePopout().catch(() => undefined);
    }
  }, [latestPositionMs, releasePlayback, windowBridge]);

  const handleClose = useCallback((): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    releasePlayback();
    void windowBridge?.closePopout().catch(() => undefined);
  }, [releasePlayback, windowBridge]);

  const isPaused = status.kind === 'paused';
  const isFailed = status.kind === 'failed';
  const showOverlay = chromeVisible || isPaused || isFailed || !payload;

  const containerPointerProps = {
    onPointerEnter: revealChrome,
    onPointerMove: revealChrome,
    onPointerLeave: () => {
      if (hideTimerRef.current !== undefined) clearTimeout(hideTimerRef.current);
      if (!isPaused) setChromeVisible(false);
    },
  } as Record<string, unknown>;

  return (
    <View
      {...containerPointerProps}
      style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]}
      testID="popout-root"
    >
      <View style={styles.stage} testID="popout-stage">
        {opened
          ? opened.renderSurface({
              statusText: '',
              failed: isFailed,
              resizeMode: 'fit',
              osdVisible: showOverlay,
              testID: 'popout-surface',
            })
          : null}
      </View>

      {showOverlay ? (
        <>
          <View
            style={[
              styles.topBar,
              DRAG_REGION_STYLE,
              {
                backgroundColor: theme.colors.topBarScrimStart,
                borderBottomColor: theme.colors.surfaceBorder,
              },
            ]}
            testID="popout-top-bar"
          >
            <View style={styles.titleRow}>
              {payload?.kind === 'live' ? (
                <View style={[styles.liveDot, { backgroundColor: theme.colors.liveColor }]} />
              ) : null}
              <View style={styles.titleCopy}>
                <Text
                  numberOfLines={1}
                  style={[
                    styles.titleText,
                    theme.typography.caption,
                    { color: theme.colors.textPrimary },
                  ]}
                  testID="popout-title"
                >
                  {payload?.title ?? ''}
                </Text>
                {payload?.subtitle ? (
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.subtitleText,
                      theme.typography.micro,
                      { color: theme.colors.textSecondary },
                    ]}
                  >
                    {payload.subtitle}
                  </Text>
                ) : null}
              </View>
            </View>
            <View style={[styles.actionsRow, NO_DRAG_REGION_STYLE]}>
              <CinemaIconButton
                icon="dock"
                label={i18n.t('player.popout.dock')}
                onPress={handleDock}
                testID="popout-dock-btn"
              />
              <CinemaIconButton
                active={pinned}
                icon="pin"
                label={pinned ? i18n.t('player.popout.unpin') : i18n.t('player.popout.pin')}
                onPress={handleTogglePin}
                testID="popout-pin-btn"
              />
              <CinemaIconButton
                icon="close"
                label={i18n.t('player.popout.close')}
                onPress={handleClose}
                testID="popout-close-btn"
              />
            </View>
          </View>

          <View
            style={[
              styles.bottomBar,
              {
                backgroundColor: theme.colors.scrimMedium,
              },
            ]}
            testID="popout-bottom-bar"
          >
            <CinemaIconButton
              icon={isPaused ? 'play' : 'pause'}
              label={isPaused ? i18n.t('player.play') : i18n.t('player.pause')}
              onPress={handleTogglePlayPause}
              testID="popout-play-pause-btn"
            />
            <CinemaIconButton
              active={muted}
              icon={muted ? 'volumeMute' : 'audio'}
              label={muted ? i18n.t('player.unmute') : i18n.t('player.mute')}
              onPress={handleToggleMute}
              testID="popout-mute-btn"
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

/** Root mounted by the Electron desktop renderer when opened with `?popout=1` (`#158`). */
export function PopoutApp(): ReactElement {
  const systemLocale = useMemo(() => {
    const languages = typeof navigator === 'undefined' ? [] : navigator.languages;
    return resolveLocale(languages);
  }, []);
  const preferencesStore = useMemo(() => createDesktopPreferencesStore(), []);
  const keymapStore = useMemo(() => createDesktopKeymapStore(), []);
  const uiAdapters = useMemo(() => createDesktopUiAdapters(), []);
  const catalog = useMemo(
    () =>
      createCoalescedCatalog(
        createLazyCatalog(() => createDesktopCatalog()),
        { windowMs: 500 },
      ),
    [],
  );
  const videoHost = useMemo(() => createDesktopVideoHost(), []);
  const windowBridge = typeof window === 'undefined' ? undefined : window.elv?.window;

  return (
    <UiAdaptersProvider adapters={uiAdapters}>
      <AppProviders
        keymapStore={keymapStore}
        preferencesStore={preferencesStore}
        profilePreferences={preferencesStore}
        systemLocale={systemLocale}
        viewport={{ formFactor: 'desktop' }}
      >
        <PopoutPlayerStage catalog={catalog} videoHost={videoHost} windowBridge={windowBridge} />
      </AppProviders>
    </UiAdaptersProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },
  stage: {
    flex: 1,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  titleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
  },
  titleCopy: {
    flex: 1,
    minWidth: 0,
  },
  titleText: {
    fontWeight: '600',
  },
  subtitleText: {
    marginTop: 1,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  iconButton: {
    width: 32,
    height: 32,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
