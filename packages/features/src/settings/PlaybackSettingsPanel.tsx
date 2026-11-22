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
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SettingsPreferencesController } from './appearance-controls';
import {
  BUFFER_PRESET_OPTIONS,
  RESIZE_MODE_OPTIONS,
  SEEK_STEP_OPTIONS,
  SUBTITLE_MODE_OPTIONS,
  TRACK_LANGUAGE_CODES,
} from './playback-controls';
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
}

type ScrollViewHandle = ComponentRef<typeof ScrollView>;

/**
 * Cinema Quietude Playback preferences panel (`#401`):
 * preferred audio & subtitle languages, subtitle activation mode, skip interval, default aspect
 * ratio, buffer preset, auto-play next episode, and subtitles on skip back.
 */
export function PlaybackSettingsPanel({
  preferences: suppliedPrefs,
  focusedControlId = null,
}: PlaybackSettingsPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';

  const scrollRef = useRef<ScrollViewHandle | null>(null);
  const cardYRef = useRef<Partial<Record<'tracks' | 'transport' | 'automation', number>>>({});

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
      focusedControlId.startsWith('buffer-')
    ) {
      const y = cardYRef.current.transport;
      if (y !== undefined) targetY = Math.max(0, y - 12);
    } else {
      const y = cardYRef.current.automation;
      if (y !== undefined) targetY = Math.max(0, y - 12);
    }
    if (targetY !== undefined) {
      scrollRef.current?.scrollTo({ y: targetY, animated: !theme.reduceMotion });
    }
  }, [focusedControlId, isTv, theme.reduceMotion]);

  const audioLangOptions = useMemo<readonly SettingsChipOption<string>[]>(
    () =>
      TRACK_LANGUAGE_CODES.map((entry) => ({
        value: entry.code,
        label: entry.endonym ?? i18n.t('settings.playback.langAuto'),
        focusId: `audio-lang-${entry.suffix}`,
        testID: `settings-playback-audio-${entry.suffix}`,
      })),
    [i18n],
  );

  const subtitleLangOptions = useMemo<readonly SettingsChipOption<string>[]>(
    () =>
      TRACK_LANGUAGE_CODES.map((entry) => ({
        value: entry.code,
        label: entry.endonym ?? i18n.t('settings.playback.langAuto'),
        focusId: `sub-lang-${entry.suffix}`,
        testID: `settings-playback-subtitle-${entry.suffix}`,
      })),
    [i18n],
  );

  const subtitleModeOptions = useMemo(
    () =>
      SUBTITLE_MODE_OPTIONS.map((opt) => ({
        value: opt.value,
        label: i18n.t(opt.labelKey),
        focusId: opt.focusId,
        testID: opt.testID,
      })),
    [i18n],
  );

  const seekStepOptions = useMemo(
    () =>
      SEEK_STEP_OPTIONS.map((opt) => ({
        value: opt.seconds,
        label: i18n.t('settings.playback.seekStepValue', { seconds: opt.seconds }),
        focusId: opt.focusId,
        testID: opt.testID,
      })),
    [i18n],
  );

  const aspectOptions = useMemo(
    () =>
      RESIZE_MODE_OPTIONS.map((opt) => ({
        value: opt.value,
        label: i18n.t(opt.labelKey),
        focusId: opt.focusId,
        testID: opt.testID,
      })),
    [i18n],
  );

  const bufferOptions = useMemo(
    () =>
      BUFFER_PRESET_OPTIONS.map((opt) => ({
        value: opt.value,
        label: i18n.t(opt.labelKey),
        focusId: opt.focusId,
        testID: opt.testID,
      })),
    [i18n],
  );

  const savedAudioDevice = activePrefs.preferredAudioDevice.trim();
  const hasCustomAudioDevice = savedAudioDevice.length > 0 && savedAudioDevice !== 'auto';
  const audioDeviceOptions = useMemo<readonly SettingsChipOption<string>[]>(() => {
    const opts: SettingsChipOption<string>[] = [
      {
        value: 'auto',
        label: i18n.t('player.audioDeviceAuto'),
        focusId: 'audio-device-auto',
        testID: 'settings-playback-audio-device-auto',
      },
    ];
    if (hasCustomAudioDevice) {
      opts.push({
        value: savedAudioDevice,
        label: savedAudioDevice,
        focusId: 'audio-device-current',
        testID: 'settings-playback-audio-device-current',
      });
    }
    return opts;
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
          options={audioLangOptions}
          selectedValue={activePrefs.preferredAudioLang}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(preferredAudioLang) => applyPatch({ preferredAudioLang })}
        />

        <SettingsDivider />

        <SettingsOptionRow
          title={i18n.t('settings.playback.subtitleLang')}
          options={subtitleLangOptions}
          selectedValue={activePrefs.preferredSubtitleLang}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(preferredSubtitleLang) => applyPatch({ preferredSubtitleLang })}
        />

        <SettingsDivider />

        <SettingsOptionRow
          title={i18n.t('settings.playback.subtitleMode')}
          options={subtitleModeOptions}
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
          options={seekStepOptions}
          selectedValue={activePrefs.seekStepSec}
          focusedControlId={focusedControlId}
          isTv={isTv}
          tabularNums
          onSelect={(seekStepSec) => applyPatch({ seekStepSec })}
        />

        <SettingsDivider />

        <SettingsOptionRow
          title={i18n.t('settings.playback.defaultAspect')}
          options={aspectOptions}
          selectedValue={activePrefs.defaultResizeMode}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(defaultResizeMode) => applyPatch({ defaultResizeMode })}
        />

        <SettingsDivider />

        <SettingsOptionRow
          title={i18n.t('settings.playback.bufferPreset')}
          options={bufferOptions}
          selectedValue={activePrefs.bufferPreset}
          focusedControlId={focusedControlId}
          isTv={isTv}
          onSelect={(bufferPreset) => applyPatch({ bufferPreset })}
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
