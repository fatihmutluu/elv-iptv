import {
  DEFAULT_PREFERENCES,
  type PreferencesPatch,
  type PreferencesSnapshot,
  type RefreshRateBucket,
} from '@elv/domain';
import { Surface, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SettingsPreferencesController } from './appearance-controls';
import { DesktopAudioPassthroughSection } from './DesktopAudioPassthroughSection';
import { buildPlaybackChipOptions } from './playback-controls';
import { RefreshRateDelayEditor } from './RefreshRateDelayEditor';
import {
  type SettingsChipOption,
  SettingsDivider,
  SettingsOptionRow,
  SettingsToggleRow,
} from './SettingsRowParts';
import type { PlaybackFocusId } from './useTvSettingsNavigation';

/** Props of {@link PlaybackSettingsPanel}. */
export interface PlaybackSettingsPanelProps {
  /** Reactive preferences controller (supplied by `AppShell` via `usePreferences()`). */
  readonly preferences?: SettingsPreferencesController;
  /** Currently focused Playback control on 10-foot TV D-pad navigation. */
  readonly focusedControlId?: PlaybackFocusId | null;
  /** Shows the Android-only Media3 Video decoder row (defaults to `Platform.OS === 'android'`, `#411`). */
  readonly showAndroidDecoder?: boolean;
  /** Shows the Android-only Night-Mode DRC row (defaults to `Platform.OS === 'android'`, `#115`). */
  readonly showNightModeDrc?: boolean;
  /** Controlled active refresh-rate bucket for the per-refresh-rate A/V delay editor (`#115`). */
  readonly selectedDelayBucket?: RefreshRateBucket;
  /** Invoked when the user selects a refresh-rate bucket in the per-refresh-rate A/V delay editor (`#115`). */
  readonly onSelectDelayBucket?: (bucket: RefreshRateBucket) => void;
}

type ScrollViewHandle = ComponentRef<typeof ScrollView>;

/**
 * Cinema Quietude Playback preferences panel (`#401`, `#393`, `#310`, `#124`, `#160`, `#118`):
 * preferred audio & subtitle languages, subtitle activation mode, skip interval, default aspect
 * ratio, buffer preset, codec/SDH preferences, OSD time display, OLED screensaver, and idle prompt.
 */
export function PlaybackSettingsPanel({
  preferences: suppliedPrefs,
  focusedControlId = null,
  showAndroidDecoder = Platform.OS === 'android',
  showNightModeDrc = Platform.OS === 'android',
  selectedDelayBucket: controlledDelayBucket,
  onSelectDelayBucket,
}: PlaybackSettingsPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';
  const isDesktop = viewport.formFactor === 'desktop';
  const isMobile = viewport.formFactor === 'phone' || viewport.formFactor === 'tablet';

  const [uncontrolledDelayBucket, setUncontrolledDelayBucket] =
    useState<RefreshRateBucket>('23.976');
  const activeDelayBucket = controlledDelayBucket ?? uncontrolledDelayBucket;
  const handleSelectDelayBucket = useCallback(
    (bucket: RefreshRateBucket): void => {
      if (controlledDelayBucket === undefined) setUncontrolledDelayBucket(bucket);
      onSelectDelayBucket?.(bucket);
    },
    [controlledDelayBucket, onSelectDelayBucket],
  );

  const scrollRef = useRef<ScrollViewHandle | null>(null);
  const cardYRef = useRef<
    Partial<Record<'tracks' | 'transport' | 'cinema' | 'displaySync' | 'automation', number>>
  >({});

  const activePrefs: PreferencesSnapshot = suppliedPrefs?.preferences ?? DEFAULT_PREFERENCES;

  const applyPatch = useCallback(
    (patch: PreferencesPatch): void => {
      if (suppliedPrefs) void suppliedPrefs.updatePreferences(patch);
    },
    [suppliedPrefs],
  );

  useEffect(() => {
    if (!isTv || !focusedControlId) return;
    let targetY: number | undefined;
    if (
      focusedControlId.startsWith('audio-lang-') ||
      focusedControlId.startsWith('sub-lang-') ||
      focusedControlId.startsWith('sub-mode-')
    ) {
      targetY = 0;
    } else if (
      focusedControlId.startsWith('seek-step-') ||
      focusedControlId.startsWith('aspect-') ||
      focusedControlId.startsWith('buffer-') ||
      focusedControlId.startsWith('video-decoder-')
    ) {
      const y = cardYRef.current.transport;
      if (y !== undefined) targetY = Math.max(0, y - 12);
    } else if (
      focusedControlId.startsWith('afr-') ||
      focusedControlId === 'toggle-auto-dynamic-range' ||
      focusedControlId.startsWith('night-drc-') ||
      focusedControlId.startsWith('delay-bucket-') ||
      focusedControlId === 'delay-stepper'
    ) {
      const y = cardYRef.current.displaySync;
      if (y !== undefined) targetY = Math.max(0, y - 12);
    } else if (
      focusedControlId.startsWith('toggle-prefer-') ||
      focusedControlId === 'toggle-filter-sdh' ||
      focusedControlId.startsWith('deinterlace-') ||
      focusedControlId === 'toggle-pitch-lock' ||
      focusedControlId === 'toggle-audio-normalization' ||
      focusedControlId === 'toggle-window-aspect-ratio-lock' ||
      focusedControlId === 'toggle-minimize-to-tray' ||
      focusedControlId === 'toggle-auto-enter-pip' ||
      focusedControlId === 'toggle-background-audio' ||
      focusedControlId.startsWith('osd-time-') ||
      focusedControlId.startsWith('oled-') ||
      focusedControlId.startsWith('still-watching-')
    ) {
      const y = cardYRef.current.cinema;
      if (y !== undefined) targetY = Math.max(0, y - 12);
    } else {
      const y = cardYRef.current.automation;
      if (y !== undefined) targetY = Math.max(0, y - 12);
    }
    if (targetY !== undefined) {
      scrollRef.current?.scrollTo({ y: targetY, animated: !theme.reduceMotion });
    }
  }, [focusedControlId, isTv, theme.reduceMotion]);

  const opts = useMemo(() => buildPlaybackChipOptions(i18n), [i18n]);

  const savedAudioDevice = activePrefs.preferredAudioDevice.trim();
  const hasCustomAudioDevice = savedAudioDevice.length > 0 && savedAudioDevice !== 'auto';
  const audioDeviceOptions = useMemo<readonly SettingsChipOption<string>[]>(() => {
    const list: SettingsChipOption<string>[] = [
      {
        value: 'auto',
        label: i18n.t('player.audioDeviceAuto'),
        focusId: 'audio-device-auto',
        testID: 'settings-playback-audio-device-auto',
      },
    ];
    if (hasCustomAudioDevice) {
      list.push({
        value: savedAudioDevice,
        label: savedAudioDevice,
        focusId: 'audio-device-current',
        testID: 'settings-playback-audio-device-current',
      });
    }
    return list;
  }, [hasCustomAudioDevice, i18n, savedAudioDevice]);

  return (
    <ScrollView
      ref={scrollRef}
      testID="settings-panel-playback"
      {...(isTv ? { focusable: false } : {})}
      style={styles.scroll}
      contentContainerStyle={[styles.content, { gap: theme.spacing.md }]}
    >
      <View style={styles.headerBlock}>
        <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
          {i18n.t('settings.playback.title')}
        </Text>
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {i18n.t('settings.playback.subtitle')}
        </Text>
      </View>

      <Surface
        tone="surface"
        bordered
        rounded="modal"
        style={styles.sectionCard}
        onLayout={(e) => {
          cardYRef.current.tracks = e.nativeEvent.layout.y;
        }}
      >
        <SettingsOptionRow
          title={i18n.t('settings.playback.audioLang')}
          options={opts.audioLangOptions}
          selectedValue={activePrefs.preferredAudioLang}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(preferredAudioLang) => applyPatch({ preferredAudioLang })}
        />
        <SettingsDivider />
        <SettingsOptionRow
          title={i18n.t('settings.playback.subtitleLang')}
          options={opts.subtitleLangOptions}
          selectedValue={activePrefs.preferredSubtitleLang}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(preferredSubtitleLang) => applyPatch({ preferredSubtitleLang })}
        />
        <SettingsDivider />
        <SettingsOptionRow
          title={i18n.t('settings.playback.subtitleMode')}
          options={opts.subtitleModeOptions}
          selectedValue={activePrefs.subtitleMode}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(subtitleMode) => applyPatch({ subtitleMode })}
        />
      </Surface>

      <Surface
        tone="surface"
        bordered
        rounded="modal"
        style={styles.sectionCard}
        onLayout={(e) => {
          cardYRef.current.transport = e.nativeEvent.layout.y;
        }}
      >
        <SettingsOptionRow
          title={i18n.t('settings.playback.seekStep')}
          options={opts.seekStepOptions}
          selectedValue={activePrefs.seekStepSec}
          focusedControlId={focusedControlId}
          isTv={isTv}
          tabularNums
          onSelect={(seekStepSec) => applyPatch({ seekStepSec })}
        />
        <SettingsDivider />
        <SettingsOptionRow
          title={i18n.t('settings.playback.defaultAspect')}
          options={opts.aspectOptions}
          selectedValue={activePrefs.defaultResizeMode}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(defaultResizeMode) => applyPatch({ defaultResizeMode })}
        />
        <SettingsDivider />
        <SettingsOptionRow
          title={i18n.t('settings.playback.bufferPreset')}
          options={opts.bufferOptions}
          selectedValue={activePrefs.bufferPreset}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(bufferPreset) => applyPatch({ bufferPreset })}
        />
        {showAndroidDecoder ? (
          <>
            <SettingsDivider />
            <SettingsOptionRow
              title={i18n.t('settings.playback.videoDecoder')}
              options={opts.videoDecoderOptions}
              selectedValue={activePrefs.androidDecoderMode}
              focusedControlId={focusedControlId}
              isTv={isTv}
              onSelect={(androidDecoderMode) => applyPatch({ androidDecoderMode })}
            />
          </>
        ) : null}
      </Surface>

      <Surface
        tone="surface"
        bordered
        rounded="modal"
        style={styles.sectionCard}
        onLayout={(e) => {
          cardYRef.current.cinema = e.nativeEvent.layout.y;
        }}
      >
        <SettingsToggleRow
          testID="settings-playback-toggle-prefer-default-audio"
          title={i18n.t('settings.playback.preferDefaultAudio')}
          description={i18n.t('settings.playback.preferDefaultAudioDesc')}
          checked={activePrefs.preferDefaultAudioTrack}
          focused={focusedControlId === 'toggle-prefer-default-audio'}
          isTv={isTv}
          onToggle={() =>
            applyPatch({ preferDefaultAudioTrack: !activePrefs.preferDefaultAudioTrack })
          }
        />
        <SettingsDivider />
        <SettingsToggleRow
          testID="settings-playback-toggle-filter-sdh"
          title={i18n.t('settings.playback.filterSdh')}
          description={i18n.t('settings.playback.filterSdhDesc')}
          checked={activePrefs.filterSdhSubtitles}
          focused={focusedControlId === 'toggle-filter-sdh'}
          isTv={isTv}
          onToggle={() => applyPatch({ filterSdhSubtitles: !activePrefs.filterSdhSubtitles })}
        />
        <SettingsDivider />
        <SettingsToggleRow
          testID="settings-playback-toggle-prefer-hevc-dv"
          title={i18n.t('settings.playback.preferHevcOverDv')}
          description={i18n.t('settings.playback.preferHevcOverDvDesc')}
          checked={activePrefs.preferHevcOverDolbyVision}
          focused={focusedControlId === 'toggle-prefer-hevc-dv'}
          isTv={isTv}
          onToggle={() =>
            applyPatch({ preferHevcOverDolbyVision: !activePrefs.preferHevcOverDolbyVision })
          }
        />
        <SettingsDivider />
        <SettingsOptionRow
          title={i18n.t('settings.deinterlaceMode')}
          description={i18n.t('settings.deinterlaceModeHint')}
          options={opts.deinterlaceOptions}
          selectedValue={activePrefs.deinterlaceMode}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(deinterlaceMode) => applyPatch({ deinterlaceMode })}
        />
        <SettingsDivider />
        <SettingsToggleRow
          testID="settings-playback-toggle-pitch-lock"
          title={i18n.t('settings.pitchLock')}
          description={i18n.t('settings.pitchLockHint')}
          checked={activePrefs.pitchLock}
          focused={focusedControlId === 'toggle-pitch-lock'}
          isTv={isTv}
          onToggle={() => applyPatch({ pitchLock: !activePrefs.pitchLock })}
        />
        <SettingsDivider />
        <SettingsToggleRow
          testID="settings-playback-toggle-audio-normalization"
          title={i18n.t('settings.audioNormalization')}
          description={i18n.t('settings.audioNormalizationHint')}
          checked={activePrefs.audioNormalization}
          focused={focusedControlId === 'toggle-audio-normalization'}
          isTv={isTv}
          onToggle={() => applyPatch({ audioNormalization: !activePrefs.audioNormalization })}
        />
        {isDesktop ? (
          <>
            <SettingsDivider />
            <SettingsToggleRow
              testID="settings-playback-toggle-window-aspect-ratio-lock"
              title={i18n.t('settings.windowAspectRatioLock')}
              description={i18n.t('settings.windowAspectRatioLockHint')}
              checked={activePrefs.windowAspectRatioLock}
              focused={focusedControlId === 'toggle-window-aspect-ratio-lock'}
              isTv={isTv}
              onToggle={() =>
                applyPatch({ windowAspectRatioLock: !activePrefs.windowAspectRatioLock })
              }
            />
            <SettingsDivider />
            <SettingsToggleRow
              testID="settings-playback-toggle-minimize-to-tray"
              title={i18n.t('settings.desktop.minimizeToTrayTitle')}
              description={i18n.t('settings.desktop.minimizeToTrayDescription')}
              checked={activePrefs.minimizeToTray}
              focused={focusedControlId === 'toggle-minimize-to-tray'}
              isTv={isTv}
              onToggle={() => applyPatch({ minimizeToTray: !activePrefs.minimizeToTray })}
            />
          </>
        ) : null}
        {isMobile ? (
          <>
            <SettingsDivider />
            <SettingsToggleRow
              testID="settings-playback-toggle-auto-enter-pip"
              title={i18n.t('settings.playback.autoEnterPipTitle')}
              description={i18n.t('settings.playback.autoEnterPipDescription')}
              checked={activePrefs.autoEnterPip}
              focused={focusedControlId === 'toggle-auto-enter-pip'}
              isTv={isTv}
              onToggle={() => applyPatch({ autoEnterPip: !activePrefs.autoEnterPip })}
            />
            <SettingsDivider />
            <SettingsToggleRow
              testID="settings-playback-toggle-background-audio"
              title={i18n.t('settings.backgroundAudio')}
              description={i18n.t('settings.backgroundAudioHint')}
              checked={activePrefs.backgroundAudioPlayback}
              focused={focusedControlId === 'toggle-background-audio'}
              isTv={isTv}
              onToggle={() =>
                applyPatch({ backgroundAudioPlayback: !activePrefs.backgroundAudioPlayback })
              }
            />
          </>
        ) : null}
        <SettingsDivider />
        <SettingsOptionRow
          title={i18n.t('settings.playback.osdTimeMode')}
          options={opts.osdTimeOptions}
          selectedValue={activePrefs.osdTimeDisplayMode}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(osdTimeDisplayMode) => applyPatch({ osdTimeDisplayMode })}
        />
        <SettingsDivider />
        <SettingsOptionRow
          title={i18n.t('settings.playback.oledScreensaver')}
          description={i18n.t('settings.playback.oledScreensaverDesc')}
          options={opts.oledOptions}
          selectedValue={activePrefs.oledScreensaverTimeoutMin}
          focusedControlId={focusedControlId}
          isTv={isTv}
          tabularNums
          onSelect={(oledScreensaverTimeoutMin) => applyPatch({ oledScreensaverTimeoutMin })}
        />
        <SettingsDivider />
        <SettingsOptionRow
          title={i18n.t('settings.playback.stillWatching')}
          description={i18n.t('settings.playback.stillWatchingDesc')}
          options={opts.stillWatchingOptions}
          selectedValue={activePrefs.stillWatchingTimeoutMin}
          focusedControlId={focusedControlId}
          isTv={isTv}
          tabularNums
          onSelect={(stillWatchingTimeoutMin) => applyPatch({ stillWatchingTimeoutMin })}
        />
      </Surface>

      <Surface
        testID="settings-section-display-audio-sync"
        tone="surface"
        bordered
        rounded="modal"
        style={styles.sectionCard}
        onLayout={(e) => {
          cardYRef.current.displaySync = e.nativeEvent.layout.y;
        }}
      >
        <SettingsOptionRow
          title={i18n.t('settings.playback.autoFrameRateTitle')}
          description={i18n.t('settings.playback.autoFrameRateDescription')}
          options={opts.autoFrameRateOptions}
          selectedValue={activePrefs.autoFrameRate}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(autoFrameRate) => applyPatch({ autoFrameRate })}
        />
        <SettingsDivider />
        <SettingsToggleRow
          testID="settings-playback-toggle-auto-dynamic-range"
          title={i18n.t('settings.playback.autoDynamicRangeTitle')}
          description={i18n.t('settings.playback.autoDynamicRangeDescription')}
          checked={activePrefs.autoDynamicRange}
          focused={focusedControlId === 'toggle-auto-dynamic-range'}
          isTv={isTv}
          onToggle={() => applyPatch({ autoDynamicRange: !activePrefs.autoDynamicRange })}
        />
        {showNightModeDrc && !isDesktop ? (
          <>
            <SettingsDivider />
            <SettingsOptionRow
              title={i18n.t('settings.playback.nightModeDrcTitle')}
              description={i18n.t('settings.playback.nightModeDrcDescription')}
              options={opts.nightModeDrcOptions}
              selectedValue={activePrefs.nightModeDrc}
              focusedControlId={focusedControlId}
              isTv={isTv}
              onSelect={(nightModeDrc) => applyPatch({ nightModeDrc })}
            />
          </>
        ) : null}
        <SettingsDivider />
        <RefreshRateDelayEditor
          delays={activePrefs.audioDelayByRefreshRateMs}
          selectedBucket={activeDelayBucket}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelectBucket={handleSelectDelayBucket}
          onChangeDelays={(audioDelayByRefreshRateMs) => applyPatch({ audioDelayByRefreshRateMs })}
        />
      </Surface>

      {isDesktop ? (
        <DesktopAudioPassthroughSection
          audioPassthrough={activePrefs.audioPassthrough}
          audioPassthroughCodecs={activePrefs.audioPassthroughCodecs}
          audioExclusive={activePrefs.audioExclusive}
          audioAc3Encode={activePrefs.audioAc3Encode}
          audioChannelLayout={activePrefs.audioChannelLayout}
          channelLayoutOptions={opts.audioChannelLayoutOptions}
          onTogglePassthrough={() =>
            applyPatch({ audioPassthrough: !activePrefs.audioPassthrough })
          }
          onChangeCodecs={(audioPassthroughCodecs) => applyPatch({ audioPassthroughCodecs })}
          onToggleExclusive={() => applyPatch({ audioExclusive: !activePrefs.audioExclusive })}
          onToggleAc3Encode={() => applyPatch({ audioAc3Encode: !activePrefs.audioAc3Encode })}
          onSelectChannelLayout={(audioChannelLayout) => applyPatch({ audioChannelLayout })}
        />
      ) : null}

      <Surface
        tone="surface"
        bordered
        rounded="modal"
        style={styles.sectionCard}
        onLayout={(e) => {
          cardYRef.current.automation = e.nativeEvent.layout.y;
        }}
      >
        <SettingsToggleRow
          testID="settings-playback-toggle-auto-play-next"
          title={i18n.t('player.autoPlayNextEpisode')}
          checked={activePrefs.autoPlayNextEpisode}
          focused={focusedControlId === 'toggle-auto-play-next'}
          isTv={isTv}
          onToggle={() => applyPatch({ autoPlayNextEpisode: !activePrefs.autoPlayNextEpisode })}
        />
        <SettingsDivider />
        <SettingsToggleRow
          testID="settings-playback-toggle-skip-back-subtitles"
          title={i18n.t('player.autoSubtitlesOnSkipBack')}
          checked={activePrefs.autoSubtitlesOnSkipBack}
          focused={focusedControlId === 'toggle-skip-back-subtitles'}
          isTv={isTv}
          onToggle={() =>
            applyPatch({ autoSubtitlesOnSkipBack: !activePrefs.autoSubtitlesOnSkipBack })
          }
        />
        <SettingsDivider />
        <SettingsToggleRow
          testID="settings-playback-toggle-group-vod-versions"
          title={i18n.t('settings.playback.groupVodVersions')}
          description={i18n.t('settings.playback.groupVodVersionsDesc')}
          checked={activePrefs.groupVodVersions}
          focused={focusedControlId === 'toggle-group-vod-versions'}
          isTv={isTv}
          onToggle={() => applyPatch({ groupVodVersions: !activePrefs.groupVodVersions })}
        />
        <SettingsDivider />
        <SettingsOptionRow
          title={i18n.t('settings.playback.audioDevice')}
          options={audioDeviceOptions}
          selectedValue={hasCustomAudioDevice ? savedAudioDevice : 'auto'}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(preferredAudioDevice) => applyPatch({ preferredAudioDevice })}
        />
      </Surface>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingBottom: 24 },
  headerBlock: { gap: 4 },
  sectionCard: { padding: 18, gap: 14 },
});
