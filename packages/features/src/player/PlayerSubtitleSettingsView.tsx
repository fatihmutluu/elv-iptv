import type { SubtitleStyleConfig } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import type { Theme } from '@elv/ui-kit';
import { Fragment, type ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import { SettingsRadioRow } from './PlayerSettingsRows';
import { SubtitleStyleSection } from './SubtitleStyleSection';
import { formatSyncDelayMs } from './settings-menu-nav';
import { buildDelayStepperItems, buildSubtitleSettingsExtraItems } from './settings-sheet-items';
import { SUBTITLE_STYLE_ROW_COUNT } from './subtitle-style-helpers';

/** Props of {@link PlayerSubtitleSettingsView}. */
export interface PlayerSubtitleSettingsViewProps {
  readonly tracks: MediaTracks;
  readonly showSubtitleDelay: boolean;
  readonly subtitleDelayMs: number;
  readonly showSubtitleStyle: boolean;
  readonly subtitleStyle: SubtitleStyleConfig;
  readonly dualSubtitles: boolean;
  readonly focusedIndex: number;
  readonly showCursor: boolean;
  readonly isTv: boolean;
  readonly theme: Theme;
  readonly i18n: AppI18n;
  readonly onAdjustSubtitleDelay?: ((deltaMs: number, reset?: boolean) => void) | undefined;
  readonly onChangeSubtitleStyle?: ((next: SubtitleStyleConfig) => void) | undefined;
  readonly onSelectSecondarySubtitle?: ((id: string | null) => void) | undefined;
  readonly onPickSubtitleFile?: (() => void) | undefined;
  readonly onLoadSubtitleUrl?: (() => void) | undefined;
}

/**
 * Level-2 `Subtitle settings` sub-view inside `PlayerSettingsSheet` (`Wave R4`):
 * Sync delay stepper (`-500ms/-100ms/0/+100ms/+500ms`), subtitle styling controls,
 * dual secondary tracks, and external file/URL loaders.
 */
export function PlayerSubtitleSettingsView({
  tracks,
  showSubtitleDelay,
  subtitleDelayMs,
  showSubtitleStyle,
  subtitleStyle,
  dualSubtitles,
  focusedIndex,
  showCursor,
  isTv,
  theme,
  i18n,
  onAdjustSubtitleDelay,
  onChangeSubtitleStyle,
  onSelectSecondarySubtitle,
  onPickSubtitleFile,
  onLoadSubtitleUrl,
}: PlayerSubtitleSettingsViewProps): ReactElement {
  const delayItems = showSubtitleDelay
    ? buildDelayStepperItems({
        kind: 'subtitle',
        delayMs: subtitleDelayMs,
        i18n,
        onAdjust: onAdjustSubtitleDelay,
      })
    : [];
  const extraItems = buildSubtitleSettingsExtraItems({
    tracks,
    dualSubtitles,
    i18n,
    onSelectSecondarySubtitle,
    onPickSubtitleFile,
    onLoadSubtitleUrl,
  });

  const styleStart = delayItems.length;
  const styleCount = showSubtitleStyle ? SUBTITLE_STYLE_ROW_COUNT : 0;
  const extraStart = styleStart + styleCount;

  return (
    <>
      {delayItems.length > 0 ? (
        <>
          <Text
            testID="player-subtitle-delay-header"
            style={[
              theme.typography.caption,
              styles.sectionHeader,
              { color: theme.colors.textSecondary },
            ]}
          >
            {`${i18n.t('player.subtitleDelay')} · ${formatSyncDelayMs(subtitleDelayMs)}`}
          </Text>
          {delayItems.map((item, idx) => (
            <SettingsRadioRow
              key={item.key}
              item={item}
              focused={showCursor && focusedIndex === idx}
              isTv={isTv}
              theme={theme}
            />
          ))}
        </>
      ) : null}

      {showSubtitleStyle ? (
        <>
          <Text
            style={[
              theme.typography.caption,
              styles.sectionHeader,
              { color: theme.colors.textSecondary },
            ]}
          >
            {i18n.t('player.subtitleStyle.section')}
          </Text>
          <SubtitleStyleSection
            style={subtitleStyle}
            focusedIndex={focusedIndex - styleStart}
            showCursor={showCursor && focusedIndex >= styleStart && focusedIndex < extraStart}
            isTv={isTv}
            i18n={i18n}
            onChange={(next) => onChangeSubtitleStyle?.(next)}
          />
        </>
      ) : null}

      {extraItems.map((item, idx) => (
        <Fragment key={item.key}>
          {item.sectionHeader !== undefined ? (
            <Text
              style={[
                theme.typography.caption,
                styles.sectionHeader,
                { color: theme.colors.textSecondary },
              ]}
            >
              {item.sectionHeader}
            </Text>
          ) : null}
          <SettingsRadioRow
            item={item}
            focused={showCursor && focusedIndex === extraStart + idx}
            isTv={isTv}
            theme={theme}
          />
        </Fragment>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  sectionHeader: { paddingTop: 8, paddingBottom: 2, paddingHorizontal: 10 },
});
