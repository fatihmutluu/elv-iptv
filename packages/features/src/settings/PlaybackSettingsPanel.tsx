import { DEFAULT_PREFERENCES, type PreferencesPatch, type PreferencesSnapshot } from '@elv/domain';
import { Surface, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SettingsPreferencesController } from './appearance-controls';
import { DesktopAudioPassthroughSection } from './DesktopAudioPassthroughSection';
import { ExternalPlayerSettingsSection } from './ExternalPlayerSettingsSection';
import { buildPlaybackChipOptions } from './playback-controls';
import { SettingsDivider, SettingsOptionRow, SettingsToggleRow } from './SettingsRowParts';
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
  /** Shows the mobile External Player row (defaults to `Platform.OS === 'android' || (Platform.OS === 'ios' && !Platform.isTV)`, `#406`). */
  readonly showExternalPlayer?: boolean;
}

type ScrollViewHandle = ComponentRef<typeof ScrollView>;

/**
 * Cinema Quietude Playback preferences panel:
 * skip interval, default aspect ratio, buffer preset, Android video decoder, SDH filtering,
 * non-desktop HEVC over Dolby Vision, pitch lock, loudness normalization, mobile PiP / background audio,
 * non-desktop Night-Mode DRC, OSD time display, auto-play next episode, desktop collapsible Advanced audio,
 * and non-desktop External Player handoff.
 */
export function PlaybackSettingsPanel({
  preferences: suppliedPrefs,
  focusedControlId = null,
  showAndroidDecoder = Platform.OS === 'android',
  showNightModeDrc = Platform.OS === 'android',
  showExternalPlayer = Platform.OS === 'android' || (Platform.OS === 'ios' && !Platform.isTV),
}: PlaybackSettingsPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';
  const isDesktop = viewport.formFactor === 'desktop';
  const isMobile = viewport.formFactor === 'phone' || viewport.formFactor === 'tablet';

  const scrollRef = useRef<ScrollViewHandle | null>(null);
  const cardYRef = useRef<
    Partial<Record<'transport' | 'cinema' | 'automation' | 'externalPlayer', number>>
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
      focusedControlId.startsWith('seek-step-') ||
      focusedControlId.startsWith('aspect-') ||
      focusedControlId.startsWith('buffer-') ||
      focusedControlId.startsWith('video-decoder-')
    ) {
      targetY = 0;
    } else if (
      focusedControlId === 'toggle-filter-sdh' ||
      focusedControlId === 'toggle-prefer-hevc-dv' ||
      focusedControlId === 'toggle-pitch-lock' ||
      focusedControlId === 'toggle-audio-normalization' ||
      focusedControlId.startsWith('night-drc-') ||
      focusedControlId.startsWith('osd-time-')
    ) {
      const y = cardYRef.current.cinema;
      if (y !== undefined) targetY = Math.max(0, y - 12);
    } else if (focusedControlId.startsWith('external-player-')) {
      const y = cardYRef.current.externalPlayer;
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
          testID="settings-playback-toggle-filter-sdh"
          title={i18n.t('settings.playback.filterSdh')}
          description={i18n.t('settings.playback.filterSdhDesc')}
          checked={activePrefs.filterSdhSubtitles}
          focused={focusedControlId === 'toggle-filter-sdh'}
          isTv={isTv}
          onToggle={() => applyPatch({ filterSdhSubtitles: !activePrefs.filterSdhSubtitles })}
        />
        {!isDesktop ? (
          <>
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
          </>
        ) : null}
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
      </Surface>

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
      </Surface>

      {isDesktop ? (
        <DesktopAudioPassthroughSection
          preferredAudioDevice={activePrefs.preferredAudioDevice}
          audioPassthrough={activePrefs.audioPassthrough}
          audioPassthroughCodecs={activePrefs.audioPassthroughCodecs}
          audioExclusive={activePrefs.audioExclusive}
          audioAc3Encode={activePrefs.audioAc3Encode}
          audioChannelLayout={activePrefs.audioChannelLayout}
          channelLayoutOptions={opts.audioChannelLayoutOptions}
          onSelectAudioDevice={(preferredAudioDevice) => applyPatch({ preferredAudioDevice })}
          onTogglePassthrough={() =>
            applyPatch({ audioPassthrough: !activePrefs.audioPassthrough })
          }
          onChangeCodecs={(audioPassthroughCodecs) => applyPatch({ audioPassthroughCodecs })}
          onToggleExclusive={() => applyPatch({ audioExclusive: !activePrefs.audioExclusive })}
          onToggleAc3Encode={() => applyPatch({ audioAc3Encode: !activePrefs.audioAc3Encode })}
          onSelectChannelLayout={(audioChannelLayout) => applyPatch({ audioChannelLayout })}
        />
      ) : null}

      {showExternalPlayer && !isDesktop ? (
        <ExternalPlayerSettingsSection
          mode={activePrefs.externalPlayerMode}
          customScheme={activePrefs.externalPlayerCustomScheme}
          modeOptions={opts.externalPlayerModeOptions}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelectMode={(externalPlayerMode) => applyPatch({ externalPlayerMode })}
          onChangeCustomScheme={(externalPlayerCustomScheme) =>
            applyPatch({ externalPlayerCustomScheme })
          }
          onLayoutY={(y) => {
            cardYRef.current.externalPlayer = y;
          }}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingBottom: 24 },
  headerBlock: { gap: 4 },
  sectionCard: { padding: 18, gap: 14 },
});
