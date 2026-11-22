import type { ItemRow } from '@elv/data';
import type { LogoBackdropModePref } from '@elv/domain';
import {
  ArtworkImage,
  MicroPill,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  webCursorPointer,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { LiveStagePreview } from './LiveWatchStage';
import { SourceBadgePill } from './SourceBadgePill';
import { formatChannelDisplayName, type SourceBadgeInfo } from './source-badge';

/** Props of {@link LivePreviewBanner}. */
export interface LivePreviewBannerProps {
  readonly channel: ItemRow;
  readonly index: number;
  readonly preview: LiveStagePreview;
  readonly padX: number;
  readonly isTv: boolean;
  readonly logoBackdropMode: LogoBackdropModePref;
  readonly sourceBadge: SourceBadgeInfo | null;
  readonly cleanChannelTitles: boolean;
  readonly onOpenFullscreen: (channel: ItemRow, index: number) => void;
}

/**
 * Compact flex-flow (HWND-safe) inline preview bar shown in `Channels` / `TV Guide` when
 * `liveOkTwoStepPreview` is active (`#145`). Displays embedded single-connection-safe preview
 * video (when `videoHost` is available) plus the localized "Press OK again for fullscreen" prompt.
 */
export const LivePreviewBanner = memo(function LivePreviewBannerInner(
  p: LivePreviewBannerProps,
): ReactElement {
  const { channel, index, preview, padX, isTv, logoBackdropMode, sourceBadge } = p;
  const { cleanChannelTitles, onOpenFullscreen } = p;
  const theme = useTheme();
  const i18n = useI18n();
  const displayName = formatChannelDisplayName(channel.name, cleanChannelTitles);
  const heading =
    channel.num !== null && channel.num !== undefined
      ? `${channel.num} · ${displayName}`
      : displayName;

  const handlePress = useCallback(() => {
    onOpenFullscreen(channel, index);
  }, [channel, index, onOpenFullscreen]);

  return (
    <Pressable
      testID="live-two-step-preview-banner"
      accessibilityRole="button"
      accessibilityLabel={`${heading}. ${i18n.t('live.pressAgainFullscreen')}`}
      focusable={!isTv}
      onPress={handlePress}
      style={[
        styles.banner,
        {
          marginHorizontal: padX,
          backgroundColor: theme.colors.bgElevated,
          borderColor: theme.colors.accent,
          borderRadius: theme.radius.card,
        },
        webCursorPointer(),
      ]}
    >
      <View
        style={[
          styles.surfaceWrap,
          { backgroundColor: theme.colors.bgCanvas, borderRadius: theme.radius.button },
        ]}
      >
        {preview.opened !== null ? (
          preview.opened.renderSurface({
            statusText: preview.statusText,
            failed: preview.failed,
            testID: 'live-two-step-preview-surface',
          })
        ) : (
          <ArtworkImage
            uri={channel.logo}
            label={displayName}
            maxDecodePx={160}
            resizeMode="contain"
            logoBackdropMode={logoBackdropMode}
            borderRadius={theme.radius.button}
            style={styles.flex1}
          />
        )}
      </View>
      <View style={styles.meta}>
        <View style={styles.titleRow}>
          <MicroPill label={i18n.t('ui.liveBadge')} tone="live" />
          <SourceBadgePill badge={sourceBadge} testID="live-two-step-source-badge" />
          <Text
            numberOfLines={1}
            style={[
              theme.typography.title,
              TABULAR_NUMS_STYLE,
              styles.flex1,
              { color: theme.colors.textPrimary },
            ]}
          >
            {heading}
          </Text>
        </View>
        <Text
          testID="live-two-step-preview-hint"
          numberOfLines={1}
          style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
        >
          {i18n.t('live.pressAgainFullscreen')}
        </Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 6,
    gap: 12,
  },
  surfaceWrap: { width: 96, height: 54, overflow: 'hidden', flexShrink: 0 },
  meta: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
