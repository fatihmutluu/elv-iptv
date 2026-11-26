import { type CatalogService, createCoalescedCatalog } from '@elv/data';
import type { KeymapStore } from '@elv/domain';
import {
  AppProviders,
  createLazyCatalog,
  DEFAULT_AUTO_HIDE_OSD_MS,
  KeymapProvider,
  noopPlaybackGuard,
  PlayerScreen,
  type PlayTarget,
  ProfileProvider,
  usePreferences,
  useProfile,
  type VideoHost,
} from '@elv/features';
import { resolveLocale } from '@elv/i18n';
import { UiAdaptersProvider, useTheme } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { PopoutLaunchPayload, WindowBridge } from '../../../src/shared/window-ipc.ts';
import { attachMouseBackGuard } from '../browser-back.ts';
import { createDesktopCatalog } from '../catalog/index.ts';
import { createDesktopVideoHost } from '../player/desktop-video-host.tsx';
import { attachScrollBlurGuard } from '../scroll-blur-guard.ts';
import { createDesktopKeymapStore } from '../storage/keymap.ts';
import { createDesktopPreferencesStore } from '../storage/preferences.ts';
import { attachDeadHostOnlineReset, createDesktopUiAdapters } from '../ui/desktop-adapters.tsx';
import {
  buildPlayTargetFromPopoutLaunch,
  buildPopoutDockPayloadFromTarget,
} from './popout-controller.ts';

/** Props of {@link PopoutPlayerStage}. */
export interface PopoutPlayerStageProps {
  readonly catalog: CatalogService;
  readonly videoHost: VideoHost;
  readonly windowBridge: WindowBridge | undefined;
}

interface PopoutSessionState {
  readonly key: number;
  readonly target: PlayTarget;
  readonly adoptEngineId?: string;
}

/**
 * Full-featured standalone Desktop Popout player stage (`#158`, Wave P3):
 * mounts the complete `<PlayerScreen>` with zero-reload live engine adoption (`adoptEngineId`),
 * full user preferences, volume slider, timeshift/cache seek, tracks, subtitles, `⋮` overflow
 * menu (including Always-on-Top), channel drawer, and zero-reload Dock-back handoff.
 */
export function PopoutPlayerStage({
  catalog,
  videoHost,
  windowBridge,
}: PopoutPlayerStageProps): ReactElement {
  const theme = useTheme();
  const preferences = usePreferences();
  const prefs = preferences.preferences;
  const [session, setSession] = useState<PopoutSessionState | null>(null);
  const closingRef = useRef(false);

  const applyLaunchPayload = useCallback((next: PopoutLaunchPayload): void => {
    closingRef.current = false;
    setSession((prev) => ({
      key: (prev?.key ?? 0) + 1,
      target: buildPlayTargetFromPopoutLaunch(next),
      ...(next.transferEngineId !== undefined ? { adoptEngineId: next.transferEngineId } : {}),
    }));
  }, []);

  useEffect(() => {
    if (!windowBridge) return;
    let active = true;
    void windowBridge
      .getPopoutPayload()
      .then((initial) => {
        if (active && initial) applyLaunchPayload(initial);
      })
      .catch(() => undefined);
    const offPayload = windowBridge.onPopoutPayload((next) => {
      if (active) applyLaunchPayload(next);
    });
    return () => {
      active = false;
      offPayload();
    };
  }, [applyLaunchPayload, windowBridge]);

  const handleTargetChange = useCallback((nextTarget: PlayTarget): void => {
    setSession((prev) => (prev ? { ...prev, target: nextTarget } : null));
  }, []);

  const handleDockPopout = useCallback(
    (target: PlayTarget, positionMs?: number, transferEngineId?: string): void => {
      if (closingRef.current) return;
      closingRef.current = true;
      const dockPayload = buildPopoutDockPayloadFromTarget(target, positionMs, transferEngineId);
      if (windowBridge) {
        void windowBridge.dockPopout(dockPayload).catch(() => undefined);
      }
    },
    [windowBridge],
  );

  const handleExit = useCallback((): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    void windowBridge?.closePopout().catch(() => undefined);
  }, [windowBridge]);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]} testID="popout-root">
      {session ? (
        <PlayerScreen
          key={session.key}
          catalog={catalog}
          videoHost={videoHost}
          target={session.target}
          viewMode="full"
          playbackGuard={noopPlaybackGuard}
          autoHideOsdMs={DEFAULT_AUTO_HIDE_OSD_MS}
          autoEnterPip={prefs.autoEnterPip}
          multiViewSupported={false}
          initialVolume={prefs.playerVolume}
          onPersistVolume={(playerVolume) => {
            void preferences.updatePreferences({ playerVolume });
          }}
          autoSubtitlesOnSkipBack={false}
          autoPlayNextEpisode={prefs.autoPlayNextEpisode}
          onToggleAutoPlayNextEpisode={() => {
            void preferences.updatePreferences({
              autoPlayNextEpisode: !prefs.autoPlayNextEpisode,
            });
          }}
          reduceMotion={prefs.reduceMotion}
          bufferPreset={prefs.bufferPreset}
          useTextureView={prefs.useTextureView}
          seekStepSec={prefs.seekStepSec}
          defaultResizeMode={prefs.defaultResizeMode}
          preferredAudioLang={prefs.preferredAudioLang}
          preferredSubtitleLang={prefs.preferredSubtitleLang}
          preferredAudioLanguages={prefs.preferredAudioLanguages}
          preferredSubtitleLanguages={prefs.preferredSubtitleLanguages}
          preferDefaultAudioTrack={prefs.preferDefaultAudioTrack}
          preferHevcOverDolbyVision={prefs.preferHevcOverDolbyVision}
          filterSdhSubtitles={prefs.filterSdhSubtitles}
          subtitleMode={prefs.subtitleMode}
          subtitleFontFamily={prefs.subtitleFontFamily}
          subtitleStyle={prefs.subtitleStyle}
          onPersistSubtitleStyle={(subtitleStyle) => {
            void preferences.updatePreferences({ subtitleStyle });
          }}
          tvClockMode={prefs.tvClockMode}
          osdTimeDisplayMode={prefs.osdTimeDisplayMode}
          onPersistOsdTimeDisplayMode={(osdTimeDisplayMode) => {
            void preferences.updatePreferences({ osdTimeDisplayMode });
          }}
          sleepTimerDefaultAction={prefs.sleepTimerDefaultAction}
          onPersistSleepTimerAction={(sleepTimerDefaultAction) => {
            void preferences.updatePreferences({ sleepTimerDefaultAction });
          }}
          stillWatchingTimeoutMin={prefs.stillWatchingTimeoutMin}
          preferredAudioDevice={prefs.preferredAudioDevice}
          onPersistAudioDevice={(preferredAudioDevice) => {
            void preferences.updatePreferences({ preferredAudioDevice });
          }}
          deinterlaceMode={prefs.deinterlaceMode}
          onPersistDeinterlaceMode={(deinterlaceMode) => {
            void preferences.updatePreferences({ deinterlaceMode });
          }}
          pitchLock={prefs.pitchLock}
          onPersistPitchLock={(pitchLock) => {
            void preferences.updatePreferences({ pitchLock });
          }}
          audioNormalization={prefs.audioNormalization}
          onPersistAudioNormalization={(audioNormalization) => {
            void preferences.updatePreferences({ audioNormalization });
          }}
          onPersistTrackLanguagePatch={(patch) => {
            void preferences.updatePreferences(patch);
          }}
          windowAspectRatioLock={prefs.windowAspectRatioLock}
          backgroundAudioPlayback={prefs.backgroundAudioPlayback}
          autoFrameRate={prefs.autoFrameRate}
          autoDynamicRange={prefs.autoDynamicRange}
          nightModeDrc={prefs.nightModeDrc}
          audioDelayByRefreshRateMs={prefs.audioDelayByRefreshRateMs}
          audioPassthrough={prefs.audioPassthrough}
          audioPassthroughCodecs={prefs.audioPassthroughCodecs}
          audioExclusive={prefs.audioExclusive}
          audioAc3Encode={prefs.audioAc3Encode}
          audioChannelLayout={prefs.audioChannelLayout}
          liveChannelSwitchMode={prefs.liveChannelSwitchMode}
          {...(session.adoptEngineId !== undefined ? { adoptEngineId: session.adoptEngineId } : {})}
          onDockPopout={handleDockPopout}
          onTargetChange={handleTargetChange}
          onExit={handleExit}
        />
      ) : null}
    </View>
  );
}

interface PopoutWithKeymapProps extends PopoutPlayerStageProps {
  readonly keymapStore: KeymapStore;
}

function PopoutWithKeymap({
  catalog,
  keymapStore,
  videoHost,
  windowBridge,
}: PopoutWithKeymapProps): ReactElement {
  const profile = useProfile();
  return (
    <KeymapProvider activeProfileId={profile.activeProfileId} keymapStore={keymapStore}>
      <PopoutPlayerStage catalog={catalog} videoHost={videoHost} windowBridge={windowBridge} />
    </KeymapProvider>
  );
}

/** Root mounted by the Electron desktop renderer when opened with `?popout=1` (`#158`, Wave P3). */
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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const offBack = attachMouseBackGuard(window);
    const offScroll = attachScrollBlurGuard(window);
    const offOnline = attachDeadHostOnlineReset(window);
    return () => {
      offBack();
      offScroll();
      offOnline();
    };
  }, []);

  return (
    <UiAdaptersProvider adapters={uiAdapters}>
      <AppProviders
        keymapStore={keymapStore}
        preferencesStore={preferencesStore}
        profilePreferences={preferencesStore}
        systemLocale={systemLocale}
        viewport={{ formFactor: 'desktop' }}
      >
        <ProfileProvider
          catalog={catalog}
          keymapStore={keymapStore}
          profilePreferences={preferencesStore}
        >
          <PopoutWithKeymap
            catalog={catalog}
            keymapStore={keymapStore}
            videoHost={videoHost}
            windowBridge={windowBridge}
          />
        </ProfileProvider>
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
});
