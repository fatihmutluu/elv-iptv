import type { AppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import type { FormFactor } from '@elv/ui-kit';
import { type ComponentRef, type ReactElement, useEffect, useRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
  onPress,
}: {
  testID: string;
  label: string;
  selected: boolean;
  tvFocused: boolean;
  isTv: boolean;
  onPress: () => void;
}): ReactElement {
  return (
    <Pressable
      testID={testID}
      {...(isTv ? { focusable: false } : {})}
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
        selected ? styles.optionRowSelected : null,
        tvFocused ? styles.optionRowTvFocused : null,
      ]}
    >
      <View style={[styles.radioDot, selected ? styles.radioDotSelected : null]} />
      <Text style={[styles.optionText, selected ? styles.optionTextSelected : null]}>{label}</Text>
    </Pressable>
  );
}

/**
 * In-window plain audio & subtitle track selector placed above `PlayerOsd` (in normal flex flow on
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
  const offLabel = i18n.t('player.subtitlesOff');
  const offSelected = tracks.selectedSubtitleId === null;
  const closeLabel = i18n.t('player.closeTracks');
  const isPhone = formFactor === 'phone';
  const showCursor = isTv || formFactor === 'desktop';
  const audioScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const subtitleScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  useEffect(() => {
    if (!showCursor) return;
    const targetRef = cursor.column === 'audio' ? audioScrollRef : subtitleScrollRef;
    targetRef.current?.scrollTo?.({
      y: Math.max(0, (cursor.index - 1) * APPROX_ROW_PITCH),
      animated: false,
    });
  }, [cursor.column, cursor.index, showCursor]);

  const listStyle = [styles.list, isPhone ? styles.listPhone : null];

  return (
    <View testID="player-tracks-panel" style={[styles.panel, isTv ? styles.panelTv : null]}>
      <View style={styles.headerRow}>
        <Text testID="player-tracks-title" style={[styles.heading, isTv ? styles.headingTv : null]}>
          {i18n.t('player.tracks')}
        </Text>
        <Pressable
          testID="player-tracks-close"
          {...(isTv ? { focusable: false } : {})}
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          onPress={(event) => {
            blurWebTarget(event.currentTarget);
            onClose();
          }}
          style={styles.closeButton}
        >
          <Text style={styles.closeText}>{closeLabel}</Text>
        </Pressable>
      </View>

      <View style={[styles.columns, isPhone ? styles.columnsStacked : styles.columnsRow]}>
        {tracks.audio.length > 0 ? (
          <View testID="player-audio-column" style={styles.column}>
            <Text style={styles.columnTitle}>{i18n.t('player.audioTracks')}</Text>
            <ScrollView
              ref={audioScrollRef}
              {...(isTv ? { focusable: false } : {})}
              style={listStyle}
            >
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
                    onPress={() => onSelectAudio(track.id)}
                  />
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        <View testID="player-subtitle-column" style={styles.column}>
          <Text style={styles.columnTitle}>{i18n.t('player.subtitleTracks')}</Text>
          <ScrollView
            ref={subtitleScrollRef}
            {...(isTv ? { focusable: false } : {})}
            style={listStyle}
          >
            <TrackRow
              testID="player-subtitle-off"
              label={offLabel}
              selected={offSelected}
              tvFocused={showCursor && cursor.column === 'subtitles' && cursor.index === 0}
              isTv={isTv}
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
    backgroundColor: 'rgba(14, 14, 20, 0.96)',
    borderTopColor: '#343442',
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
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
  heading: {
    color: '#f4f4f6',
    fontSize: 16,
    fontWeight: '700',
  },
  headingTv: {
    fontSize: 20,
  },
  closeButton: {
    backgroundColor: '#1e1e26',
    borderColor: '#3a3a46',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  closeText: {
    color: '#f4f4f6',
    fontSize: 13,
    fontWeight: '600',
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
  columnTitle: {
    color: '#b4b8c4',
    fontSize: 13,
    fontWeight: '600',
  },
  list: {
    maxHeight: 140,
  },
  listPhone: {
    maxHeight: 88,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#191922',
    borderColor: '#2e2e3a',
    borderWidth: 2,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 6,
  },
  optionRowSelected: {
    backgroundColor: '#252533',
    borderColor: '#8d92a6',
  },
  optionRowTvFocused: {
    borderColor: '#ffffff',
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#6b7084',
  },
  radioDotSelected: {
    backgroundColor: '#ffffff',
    borderColor: '#ffffff',
  },
  optionText: {
    color: '#d4d7e0',
    fontSize: 14,
    fontWeight: '500',
  },
  optionTextSelected: {
    color: '#ffffff',
    fontWeight: '700',
  },
});
