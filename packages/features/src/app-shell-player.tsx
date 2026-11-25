import type { CatalogService, SourceRow } from '@elv/data';
import type { ConnectionTracker } from '@elv/playback';
import type { ComponentProps, ReactElement } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { ShellPlaybackModes } from './app-shell-desktop';
import { DEFAULT_AUTO_HIDE_OSD_MS, MultiViewStage, PlayerScreen } from './player';
import type { AppLifecyclePort } from './ports/app-lifecycle';
import type { PlayTarget } from './ports/play-target';
import type { PlaybackGuard } from './ports/playback-guard';
import type { ThermalDevicePort, VideoHost } from './ports/video-host';
import { CrashRecoveryBoundary, type PreferencesContextValue } from './shell';

/** Props of {@link AppShellPlayerView}. */
interface AppShellPlayerViewProps {
  readonly catalog: CatalogService;
  readonly videoHost: VideoHost;
  readonly target: PlayTarget;
  readonly viewMode?: 'full' | 'mini';
  readonly playbackGuard: PlaybackGuard;
  readonly preferences: PreferencesContextValue;
  readonly appLifecycle?: AppLifecyclePort;
  readonly multiViewSupported?: boolean;
  readonly restoreCursorToken?: number;
  readonly externalOverlayOpen?: boolean;
  readonly onMinimizeToMiniPlayer?: () => void;
  readonly onExpandMiniPlayer?: () => void;
  readonly onEnterMultiView?: (target: PlayTarget) => void;
  readonly onPopoutPlayer?: (target: PlayTarget, positionMs?: number) => void;
  readonly onPlaybackActiveChange: (active: boolean) => void;
  readonly onRegisterStopActivePlayer?: (stop: (() => Promise<void>) | null) => void;
  readonly onTargetChange: (next: PlayTarget) => void;
  readonly onExit: () => void;
}

/** Wires active user preferences and platform ports into {@link PlayerScreen} for `AppShell`. */
function AppShellPlayerView({
  catalog,
  videoHost,
  target,
  viewMode = 'full',
  playbackGuard,
  preferences,
  appLifecycle,
  multiViewSupported = false,
  restoreCursorToken = 0,
  externalOverlayOpen,
  onMinimizeToMiniPlayer,
  onExpandMiniPlayer,
  onEnterMultiView,
  onPopoutPlayer,
  onRegisterStopActivePlayer,
  onPlaybackActiveChange,
  onTargetChange,
  onExit,
}: AppShellPlayerViewProps): ReactElement {
  const prefs = preferences.preferences;
  return (
    <PlayerScreen
      catalog={catalog}
      videoHost={videoHost}
      target={target}
      viewMode={viewMode}
      playbackGuard={playbackGuard}
      autoHideOsdMs={DEFAULT_AUTO_HIDE_OSD_MS}
      autoEnterPip={prefs.autoEnterPip}
      multiViewSupported={multiViewSupported}
      restoreCursorToken={restoreCursorToken}
      initialVolume={prefs.playerVolume}
      onPersistVolume={(playerVolume) => {
        void preferences.updatePreferences({ playerVolume });
      }}
      autoSubtitlesOnSkipBack={prefs.autoSubtitlesOnSkipBack}
      onToggleAutoSubtitlesOnSkipBack={() => {
        void preferences.updatePreferences({
          autoSubtitlesOnSkipBack: !prefs.autoSubtitlesOnSkipBack,
        });
      }}
      autoPlayNextEpisode={prefs.autoPlayNextEpisode}
      onToggleAutoPlayNextEpisode={() => {
        void preferences.updatePreferences({ autoPlayNextEpisode: !prefs.autoPlayNextEpisode });
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
      onPlaybackActiveChange={onPlaybackActiveChange}
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
      windowAspectRatioLock={prefs.windowAspectRatioLock}
      backgroundAudioPlayback={prefs.backgroundAudioPlayback}
      {...(Platform.OS === 'android'
        ? {
            androidDecoderMode: prefs.androidDecoderMode,
            onSelectAndroidDecoderMode: (androidDecoderMode) => {
              void preferences.updatePreferences({ androidDecoderMode });
            },
          }
        : {})}
      {...(appLifecycle !== undefined ? { appLifecycle } : {})}
      {...(externalOverlayOpen !== undefined ? { externalOverlayOpen } : {})}
      {...(onMinimizeToMiniPlayer !== undefined ? { onMinimizeToMiniPlayer } : {})}
      {...(onExpandMiniPlayer !== undefined ? { onExpandMiniPlayer } : {})}
      {...(onEnterMultiView !== undefined ? { onEnterMultiView } : {})}
      {...(onPopoutPlayer !== undefined ? { onPopoutPlayer } : {})}
      {...(onRegisterStopActivePlayer !== undefined ? { onRegisterStopActivePlayer } : {})}
      liveChannelSwitchMode={prefs.liveChannelSwitchMode}
      onTargetChange={onTargetChange}
      onExit={onExit}
    />
  );
}

/** Props of {@link AppShellPlayerHost}. */
export interface AppShellPlayerHostProps {
  readonly catalog: CatalogService;
  readonly videoHost: VideoHost;
  readonly tracker: ConnectionTracker;
  readonly sources: readonly SourceRow[];
  readonly thermalDevice?: ThermalDevicePort | undefined;
  readonly playTarget: PlayTarget | null;
  readonly modes: ShellPlaybackModes;
  readonly playbackGuard: PlaybackGuard;
  readonly preferences: PreferencesContextValue;
  readonly appLifecycle?: AppLifecyclePort;
  readonly externalOverlayOpen: boolean;
  readonly crashProps: Omit<ComponentProps<typeof CrashRecoveryBoundary>, 'resetKey' | 'children'>;
  readonly onPlaybackActiveChange: (active: boolean) => void;
  readonly onRegisterStopActivePlayer?: (stop: (() => Promise<void>) | null) => void;
  readonly onTargetChange: (next: PlayTarget) => void;
  readonly onExit: () => void;
}

/**
 * Renders either the Multi-View grid or the persistent sibling `AppShellPlayerView` container
 * (`'full'` or floating `'mini'` without remounting `PlayerScreen` / `usePlayerSession`).
 */
export function AppShellPlayerHost(p: AppShellPlayerHostProps): ReactElement | null {
  const { modes } = p;
  if (modes.multiViewSeed !== null) {
    return (
      <MultiViewStage
        catalog={p.catalog}
        videoHost={p.videoHost}
        tracker={p.tracker}
        sources={p.sources}
        thermalDevice={p.thermalDevice}
        initialSeed={modes.multiViewSeed}
        onExit={modes.exitMultiView}
      />
    );
  }
  if (p.playTarget === null) return null;
  return (
    <View
      pointerEvents={modes.playerViewMode === 'mini' ? 'box-none' : 'auto'}
      style={modes.playerViewMode === 'mini' ? hostStyles.miniHost : hostStyles.fullHost}
    >
      <CrashRecoveryBoundary resetKey={p.playTarget.itemKey} {...p.crashProps}>
        <AppShellPlayerView
          catalog={p.catalog}
          videoHost={p.videoHost}
          target={p.playTarget}
          viewMode={modes.playerViewMode}
          playbackGuard={p.playbackGuard}
          preferences={p.preferences}
          multiViewSupported={modes.multiViewSupported}
          restoreCursorToken={modes.restoreCursorToken}
          {...(p.appLifecycle !== undefined ? { appLifecycle: p.appLifecycle } : {})}
          externalOverlayOpen={p.externalOverlayOpen}
          onMinimizeToMiniPlayer={modes.minimizeToMiniPlayer}
          onExpandMiniPlayer={modes.expandMiniPlayer}
          onEnterMultiView={modes.enterMultiView}
          {...(modes.popoutPlayer !== undefined ? { onPopoutPlayer: modes.popoutPlayer } : {})}
          {...(p.onRegisterStopActivePlayer !== undefined
            ? { onRegisterStopActivePlayer: p.onRegisterStopActivePlayer }
            : {})}
          onPlaybackActiveChange={p.onPlaybackActiveChange}
          onTargetChange={p.onTargetChange}
          onExit={p.onExit}
        />
      </CrashRecoveryBoundary>
    </View>
  );
}

const hostStyles = StyleSheet.create({
  fullHost: { flex: 1 },
  miniHost: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 45,
  },
});
