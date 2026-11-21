import type { AppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import {
  type FormFactor,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ComponentRef, type ReactElement, useEffect, useRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useDesktopDialogTrap } from './desktop-dialog-trap';
import { formatTrackLabel } from './track-labels';
import type { TrackPickerCursor } from './track-picker-nav';

export type { TrackPickerCursor } from './track-picker-nav';

const APPROX_ROW_PITCH = 42;

function blurWebTarget(target: unknown): void {
  if ((Platform.OS as string) === 'web') {
    (target as { blur?: () => void } | null | undefined)?.blur?.();
  }
}

function TrackRow({
  testID,
  label,
  selected,
  tvFocused,
  isTv,
  isTouch,
  onPress,
}: {
  testID: string;
  label: string;
  selected: boolean;
  tvFocused: boolean;
  isTv: boolean;
  isTouch: boolean;
  onPress: () => void;
}): ReactElement {
  const theme = useTheme();
  const borderColor = tvFocused
    ? theme.colors.focusRingColor
    : selected
      ? theme.colors.accent
      : theme.colors.surfaceBorder;
  const borderWidth = tvFocused ? theme.focus.ringWidth : 1.5;

  return (
    <Pressable
      testID={testID}
      focusable={!isTv}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, checked: selected }}
      aria-checked={selected}
      onPress={(event) => {
        blurWebTarget(event.currentTarget);
        onPress();
      }}
      style={[
        styles.optionRow,
        {
          minHeight: isTouch ? 44 : 40,
          borderRadius: theme.radius.card,
          backgroundColor: selected ? theme.colors.accentTint : theme.colors.bgSurface,
          borderColor,
          borderWidth,
        },
        webTransition(theme, 'border-color, background-color'),
        !isTv ? webCursorPointer() : undefined,
      ]}
    >
      <View
        style={[
          styles.radioDot,
          {
            borderRadius: theme.radius.pill,
            borderColor: selected ? theme.colors.accent : theme.colors.textMuted,
            backgroundColor: selected ? theme.colors.accent : 'transparent',
          },
        ]}
      />
      <Text
        numberOfLines={1}
        style={[
          theme.typography.title,
          styles.optionText,
          {
            color: selected ? theme.colors.textPrimary : theme.colors.textSecondary,
            fontWeight: selected ? '700' : '500',
          },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * In-window audio & subtitle track selector placed above `PlayerOsd` (in normal flex flow on
 * desktop so the native `mpv` child window shrinks above it without overlapping).
 */
export function TrackPickerModal({
  tracks,
  cursor,
  isTv,
  formFactor,
  i18n,
  onSelectAudio,
  onSelectSubtitle,
  onClose,
}: {
  tracks: MediaTracks;
  cursor: TrackPickerCursor;
  isTv: boolean;
  formFactor: FormFactor;
  i18n: AppI18n;
  onSelectAudio: (id: string) => void;
  onSelectSubtitle: (id: string | null) => void;
  onClose: () => void;
}): ReactElement {
  const theme = useTheme();
  const offLabel = i18n.t('player.subtitlesOff');
  const offSelected = tracks.selectedSubtitleId === null;
  const closeLabel = i18n.t('player.closeTracks');
  const isPhone = formFactor === 'phone';
  const isTouch = formFactor === 'phone' || formFactor === 'tablet';
  const isWebDesktop = formFactor === 'desktop' && (Platform.OS as string) === 'web';
  const showCursor = isTv || formFactor === 'desktop';
  const panelRef = useRef<ComponentRef<typeof View> | null>(null);
  const audioScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const subtitleScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  useDesktopDialogTrap(panelRef, isWebDesktop, onClose);

  useEffect(() => {
    if (!showCursor) return;
    const targetRef = cursor.column === 'audio' ? audioScrollRef : subtitleScrollRef;
    targetRef.current?.scrollTo?.({
      y: Math.max(0, (cursor.index - 1) * APPROX_ROW_PITCH),
      animated: false,
    });
  }, [cursor.column, cursor.index, showCursor]);

  const listStyle = [styles.list, isPhone ? styles.listPhone : null];
  const dialogA11yProps = isWebDesktop
    ? ({
        role: 'dialog',
        'aria-modal': true,
        'aria-label': i18n.t('player.tracks'),
      } as Record<string, unknown>)
    : undefined;

  return (
    <View
      ref={panelRef}
      testID="player-tracks-panel"
      {...dialogA11yProps}
      style={[
        styles.panel,
        isTv ? styles.panelTv : null,
        {
          backgroundColor: theme.colors.glassBg,
          borderTopColor: theme.colors.glassBorder,
        },
        webBackdropBlur(20),
      ]}
    >
      <View style={styles.headerRow}>
        <Text
          testID="player-tracks-title"
          style={[
            theme.typography.h2,
            isTv ? styles.headingTv : null,
            { color: theme.colors.textPrimary },
          ]}
        >
          {i18n.t('player.tracks')}
        </Text>
        <Pressable
          testID="player-tracks-close"
          focusable={!isTv}
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          onPress={(event) => {
            blurWebTarget(event.currentTarget);
            onClose();
          }}
          style={[
            styles.closeButton,
            {
              backgroundColor: theme.colors.actionGlassBg,
              borderColor: theme.colors.actionGlassBorder,
              borderRadius: theme.radius.button,
            },
            !isTv ? webCursorPointer() : undefined,
          ]}
        >
          <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
            {closeLabel}
          </Text>
        </Pressable>
      </View>

      <View style={[styles.columns, isPhone ? styles.columnsStacked : styles.columnsRow]}>
        {tracks.audio.length > 0 ? (
          <View testID="player-audio-column" style={styles.column}>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('player.audioTracks')}
            </Text>
            <ScrollView ref={audioScrollRef} focusable={!isTv} style={listStyle}>
              {tracks.audio.map((track, idx) => {
                const label = formatTrackLabel(track, idx, tracks.audio, i18n);
                return (
                  <TrackRow
                    key={track.id}
                    testID={`player-audio-track-${track.id}`}
                    label={label}
                    selected={tracks.selectedAudioId === track.id}
                    tvFocused={showCursor && cursor.column === 'audio' && cursor.index === idx}
                    isTv={isTv}
                    isTouch={isTouch}
                    onPress={() => onSelectAudio(track.id)}
                  />
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        <View testID="player-subtitle-column" style={styles.column}>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('player.subtitleTracks')}
          </Text>
          <ScrollView ref={subtitleScrollRef} focusable={!isTv} style={listStyle}>
            <TrackRow
              testID="player-subtitle-off"
              label={offLabel}
              selected={offSelected}
              tvFocused={showCursor && cursor.column === 'subtitles' && cursor.index === 0}
              isTv={isTv}
              isTouch={isTouch}
              onPress={() => onSelectSubtitle(null)}
            />
            {tracks.subtitles.map((track, idx) => {
              const label = formatTrackLabel(track, idx, tracks.subtitles, i18n);
              return (
                <TrackRow
                  key={track.id}
                  testID={`player-subtitle-track-${track.id}`}
                  label={label}
                  selected={tracks.selectedSubtitleId === track.id}
                  tvFocused={
                    showCursor && cursor.column === 'subtitles' && cursor.index === idx + 1
                  }
                  isTv={isTv}
                  isTouch={isTouch}
                  onPress={() => onSelectSubtitle(track.id)}
                />
              );
            })}
          </ScrollView>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  panelTv: {
    paddingHorizontal: 48,
    paddingVertical: 16,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  headingTv: {
    fontSize: 20,
  },
  closeButton: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 40,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  columns: {
    gap: 12,
  },
  columnsRow: {
    flexDirection: 'row',
  },
  columnsStacked: {
    flexDirection: 'column',
  },
  column: {
    flex: 1,
    gap: 6,
  },
  list: {
    maxHeight: 152,
  },
  listPhone: {
    maxHeight: 96,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 6,
  },
  radioDot: {
    width: 10,
    height: 10,
    borderWidth: 1.5,
  },
  optionText: {
    flex: 1,
  },
});
