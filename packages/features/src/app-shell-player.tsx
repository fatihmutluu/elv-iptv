import type { CatalogService } from '@elv/data';
import type { ReactElement } from 'react';
import { Platform } from 'react-native';
import { DEFAULT_AUTO_HIDE_OSD_MS, PlayerScreen } from './player';
import type { AppLifecyclePort } from './ports/app-lifecycle';
import type { PlayTarget } from './ports/play-target';
import type { PlaybackGuard } from './ports/playback-guard';
import type { VideoHost } from './ports/video-host';
import type { PreferencesContextValue } from './shell';

/** Props of {@link AppShellPlayerView}. */
export interface AppShellPlayerViewProps {
  readonly catalog: CatalogService;
  readonly videoHost: VideoHost;
  readonly target: PlayTarget;
  readonly playbackGuard: PlaybackGuard;
  readonly preferences: PreferencesContextValue;
  readonly appLifecycle?: AppLifecyclePort;
  readonly externalOverlayOpen?: boolean;
  readonly onPlaybackActiveChange: (active: boolean) => void;
  readonly onTargetChange: (next: PlayTarget) => void;
  readonly onExit: () => void;
}

/** Wires active user preferences and platform ports into {@link PlayerScreen} for `AppShell`. */
export function AppShellPlayerView({
  catalog,
  videoHost,
  target,
  playbackGuard,
  preferences,
  appLifecycle,
  externalOverlayOpen,
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
      playbackGuard={playbackGuard}
      autoHideOsdMs={DEFAULT_AUTO_HIDE_OSD_MS}
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
      liveChannelSwitchMode={prefs.liveChannelSwitchMode}
      onTargetChange={onTargetChange}
      onExit={onExit}
    />
  );
}
