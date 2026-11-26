import type { SearchEpisodeHit, SearchProgrammeHit } from '@elv/data';
import {
  MicroPill,
  TABULAR_NUMS_STYLE,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatSearchProgrammeTime } from './search-model';

/** Props of {@link SearchEpgCardItem}. */
export interface SearchEpgCardItemProps {
  readonly hit: SearchProgrammeHit;
  readonly index: number;
  readonly width: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly nowMs: number;
  readonly airingNowLabel: string;
  readonly upcomingLabel: string;
  readonly onSelectEpg?: (programme: SearchProgrammeHit) => void;
}

/** EPG programme card rendered inside Search results. */
export const SearchEpgCardItem = memo(function SearchEpgCardItemInner({
  hit,
  index,
  width,
  isTv,
  focused,
  nowMs,
  airingNowLabel,
  upcomingLabel,
  onSelectEpg,
}: SearchEpgCardItemProps): ReactElement {
  const theme = useTheme();
  const handlePress = useCallback(() => {
    onSelectEpg?.(hit);
  }, [hit, onSelectEpg]);

  const isEnded = !hit.isLiveNow && hit.stop < nowMs;
  const badgeLabel = hit.isLiveNow ? airingNowLabel : isEnded ? null : upcomingLabel;
  const timeWindow = `${formatSearchProgrammeTime(hit.start)} – ${formatSearchProgrammeTime(hit.stop)}`;
  const channelSubtitle = hit.category ? `${hit.channelName} · ${hit.category}` : hit.channelName;

  return (
    <Pressable
      testID={`search-epg-item-${index}`}
      accessibilityRole="button"
      accessibilityLabel={
        badgeLabel !== null
          ? `${hit.title}, ${hit.channelName}, ${badgeLabel}, ${timeWindow}`
          : `${hit.title}, ${hit.channelName}, ${timeWindow}`
      }
      focusable={!isTv}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.epgCard,
        webTransition(theme, 'background-color, border-color, opacity, transform'),
        webCursorPointer(),
        {
          width,
          borderRadius: theme.radius.card,
          backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgSurface,
          borderColor: focused ? 'transparent' : theme.colors.surfaceBorder,
          borderWidth: 1,
          opacity: pressed ? 0.88 : 1,
          transform: [{ scale: focused ? theme.focus.buttonScale : 1 }],
        },
      ]}
    >
      <View style={styles.epgTopRow}>
        {badgeLabel !== null ? (
          <MicroPill
            testID={`search-epg-item-${index}-badge`}
            label={badgeLabel}
            tone={hit.isLiveNow ? 'live' : 'accent'}
          />
        ) : null}
        <Text
          testID={`search-epg-item-${index}-time`}
          numberOfLines={1}
          style={[
            theme.typography.micro,
            TABULAR_NUMS_STYLE,
            { color: theme.colors.textMuted, flexShrink: 0 },
          ]}
        >
          {timeWindow}
        </Text>
      </View>
      <Text
        testID={`search-epg-item-${index}-title`}
        numberOfLines={1}
        style={[
          theme.typography.title,
          { color: theme.colors.textPrimary, fontWeight: '600', marginTop: 6 },
        ]}
      >
        {hit.title}
      </Text>
      <Text
        testID={`search-epg-item-${index}-channel`}
        numberOfLines={1}
        style={[theme.typography.caption, { color: theme.colors.textSecondary, marginTop: 2 }]}
      >
        {channelSubtitle}
      </Text>
      {focused ? (
        <View
          pointerEvents="none"
          testID={`search-epg-item-${index}-focus-ring`}
          style={[
            styles.cardFocusRing,
            {
              borderRadius: theme.radius.card,
              borderWidth: theme.focus.ringWidth,
              borderColor: theme.colors.focusRingColor,
            },
          ]}
        />
      ) : null}
    </Pressable>
  );
});

/** Props of {@link SearchEpisodeCardItem}. */
export interface SearchEpisodeCardItemProps {
  readonly hit: SearchEpisodeHit;
  readonly index: number;
  readonly episodeLabel: string;
  readonly width: number;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly onSelectEpisode?: (episode: SearchEpisodeHit) => void;
}

/** Episode hit card rendered inside Search results. */
export const SearchEpisodeCardItem = memo(function SearchEpisodeCardItemInner({
  hit,
  index,
  episodeLabel,
  width,
  isTv,
  focused,
  onSelectEpisode,
}: SearchEpisodeCardItemProps): ReactElement {
  const theme = useTheme();
  const handlePress = useCallback(() => {
    onSelectEpisode?.(hit);
  }, [hit, onSelectEpisode]);

  const displayTitle = hit.title.trim() || episodeLabel;

  return (
    <Pressable
      testID={`search-episode-item-${index}`}
      accessibilityRole="button"
      accessibilityLabel={`${hit.seriesName}, ${episodeLabel}, ${displayTitle}`}
      focusable={!isTv}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.epgCard,
        webTransition(theme, 'background-color, border-color, opacity, transform'),
        webCursorPointer(),
        {
          width,
          borderRadius: theme.radius.card,
          backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgSurface,
          borderColor: focused ? 'transparent' : theme.colors.surfaceBorder,
          borderWidth: 1,
          opacity: pressed ? 0.88 : 1,
          transform: [{ scale: focused ? theme.focus.buttonScale : 1 }],
        },
      ]}
    >
      <View style={styles.epgTopRow}>
        <Text
          testID={`search-episode-item-${index}-series`}
          numberOfLines={1}
          style={[
            theme.typography.caption,
            { color: theme.colors.textSecondary, flex: 1, fontWeight: '600' },
          ]}
        >
          {hit.seriesName}
        </Text>
        <MicroPill
          testID={`search-episode-item-${index}-label`}
          label={episodeLabel}
          tone="neutral"
        />
      </View>
      <Text
        testID={`search-episode-item-${index}-title`}
        numberOfLines={1}
        style={[
          theme.typography.title,
          { color: theme.colors.textPrimary, fontWeight: '600', marginTop: 6 },
        ]}
      >
        {displayTitle}
      </Text>
      {focused ? (
        <View
          pointerEvents="none"
          testID={`search-episode-item-${index}-focus-ring`}
          style={[
            styles.cardFocusRing,
            {
              borderRadius: theme.radius.card,
              borderWidth: theme.focus.ringWidth,
              borderColor: theme.colors.focusRingColor,
            },
          ]}
        />
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  epgCard: {
    position: 'relative',
    minHeight: 84,
    paddingHorizontal: 14,
    paddingVertical: 12,
    justifyContent: 'center',
  },
  epgTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardFocusRing: {
    position: 'absolute',
    top: -2,
    bottom: -2,
    left: -2,
    right: -2,
  },
});
