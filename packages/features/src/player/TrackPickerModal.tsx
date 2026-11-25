import type { AppI18n } from '@elv/i18n';
import {
  filterTracksByProgram,
  hasMultiplePrograms,
  type MediaTracks,
  type ProgramInfo,
} from '@elv/playback';
import {
  type FormFactor,
  Icon,
  MicroPill,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ComponentRef, Fragment, type ReactElement, useEffect, useRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useDesktopDialogTrap } from './desktop-dialog-trap';
import { formatTrackLabel } from './track-labels';
import {
  buildSubtitleColumnEntries,
  type TrackPickerCursor,
  type TrackPickerOptions,
} from './track-picker-nav';

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
  disabled = false,
  badgeLabel,
  badgeTestID,
  disabledHint,
  disabledHintTestID,
  role = 'radio',
  tvFocused,
  isTv,
  isTouch,
  onPress,
}: {
  testID: string;
  label: string;
  selected: boolean;
  disabled?: boolean;
  badgeLabel?: string;
  badgeTestID?: string;
  disabledHint?: string;
  disabledHintTestID?: string;
  role?: 'radio' | 'button';
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
      disabled={disabled}
      focusable={!isTv && !disabled}
      accessibilityRole={role}
      accessibilityLabel={disabledHint ? `${label} (${disabledHint})` : label}
      accessibilityState={
        role === 'radio'
          ? { selected, checked: selected, ...(disabled ? { disabled: true } : {}) }
          : { ...(disabled ? { disabled: true } : {}) }
      }
      {...(role === 'radio' ? { 'aria-checked': selected } : {})}
      onPress={(event) => {
        if (disabled) return;
        blurWebTarget(event.currentTarget);
        onPress();
      }}
      style={[
        styles.optionRow,
        {
          minHeight: Math.round((isTouch ? 44 : 40) * Math.max(1, theme.fontScale)),
          borderRadius: theme.radius.card,
          backgroundColor: selected ? theme.colors.accentTint : theme.colors.bgSurface,
          borderColor,
          borderWidth,
          opacity: disabled ? 0.55 : 1,
        },
        webTransition(theme, 'border-color, background-color'),
        !isTv && !disabled ? webCursorPointer() : undefined,
      ]}
    >
      <Text
        numberOfLines={1}
        style={[
          theme.typography.title,
          styles.optionText,
          {
            color: disabled
              ? theme.colors.textMuted
              : selected
                ? theme.colors.textPrimary
                : theme.colors.textSecondary,
            fontWeight: selected ? '700' : '500',
          },
        ]}
      >
        {label}
      </Text>
      {badgeLabel !== undefined ? (
        <MicroPill
          {...(badgeTestID !== undefined ? { testID: badgeTestID } : {})}
          label={badgeLabel}
          tone="accent"
        />
      ) : null}
      {disabledHint !== undefined ? (
        <MicroPill
          {...(disabledHintTestID !== undefined ? { testID: disabledHintTestID } : {})}
          label={disabledHint}
          tone="neutral"
        />
      ) : null}
      {selected ? <Icon name="check" size={16} color={theme.colors.accent} /> : null}
    </Pressable>
  );
}

function formatProgramLabel(program: ProgramInfo, i18n: AppI18n): string {
  if (program.serviceName !== undefined && program.serviceName.trim().length > 0) {
    return program.serviceName.trim();
  }
  if (program.label.trim().length > 0) return program.label.trim();
  if (program.programNumber !== undefined) {
    return i18n.t('player.tracks.programNumber', { number: program.programNumber });
  }
  return program.id;
}

/**
 * In-window audio, subtitle & conditional multi-program TS selector placed above `PlayerOsd`
 * (in normal flex flow on desktop so the native `mpv` child window shrinks above it without overlapping).
 */
export function TrackPickerModal({
  tracks,
  cursor,
  isTv,
  formFactor,
  i18n,
  dualSubtitles = false,
  onSelectProgram,
  onSelectAudio,
  onSelectSubtitle,
  onSelectSecondarySubtitle,
  onPickSubtitleFile,
  onLoadSubtitleUrl,
  onClose,
}: {
  tracks: MediaTracks;
  cursor: TrackPickerCursor;
  isTv: boolean;
  formFactor: FormFactor;
  i18n: AppI18n;
  dualSubtitles?: boolean;
  onSelectProgram?: (id: string) => void;
  onSelectAudio: (id: string) => void;
  onSelectSubtitle: (id: string | null) => void;
  onSelectSecondarySubtitle?: (id: string | null) => void;
  onPickSubtitleFile?: () => void;
  onLoadSubtitleUrl?: () => void;
  onClose: () => void;
}): ReactElement {
  const theme = useTheme();
  const viewport = useViewport();
  const safeFontScale = Number.isFinite(theme.fontScale) ? Math.max(1, theme.fontScale) : 1;
  const rowPitch = Math.round(APPROX_ROW_PITCH * safeFontScale);
  const showPrograms = hasMultiplePrograms(tracks);
  const displayTracks = showPrograms ? filterTracksByProgram(tracks) : tracks;
  const programs = showPrograms ? (tracks.programs ?? []) : [];
  const offLabel = i18n.t('player.subtitlesOff');
  const offSelected = displayTracks.selectedSubtitleId === null;
  const secondaryOffSelected = (displayTracks.selectedSecondarySubtitleId ?? null) === null;
  const externalBadge = i18n.t('player.externalSubtitle.badge');
  const sameAsPrimaryHint = i18n.t('player.secondarySameAsPrimary');
  const closeLabel = i18n.t('player.closeTracks');
  const isPhone = formFactor === 'phone';
  const isTouch = formFactor === 'phone' || formFactor === 'tablet';
  const isWebDesktop = formFactor === 'desktop' && (Platform.OS as string) === 'web';
  const showCursor = isTv || formFactor === 'desktop';
  const panelRef = useRef<ComponentRef<typeof View> | null>(null);
  const programScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const audioScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const subtitleScrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  const pickerOptions: TrackPickerOptions = {
    dualSubtitles: dualSubtitles && onSelectSecondarySubtitle !== undefined,
    canPickSubtitleFile: onPickSubtitleFile !== undefined,
    canLoadSubtitleUrl: onLoadSubtitleUrl !== undefined,
  };
  const subtitleEntries = buildSubtitleColumnEntries(displayTracks, pickerOptions);
  const firstExternalIdx = subtitleEntries.findIndex(
    (entry) => entry.kind === 'pickSubtitleFile' || entry.kind === 'loadSubtitleUrl',
  );

  useDesktopDialogTrap(panelRef, isWebDesktop, onClose);

  useEffect(() => {
    if (!showCursor) return;
    const targetRef =
      cursor.column === 'program'
        ? programScrollRef
        : cursor.column === 'audio'
          ? audioScrollRef
          : subtitleScrollRef;
    targetRef.current?.scrollTo?.({
      y: Math.max(0, (cursor.index - 1) * rowPitch),
      animated: false,
    });
  }, [cursor.column, cursor.index, rowPitch, showCursor]);

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
        isTv
          ? {
              paddingHorizontal: 48 + viewport.overscan.x,
              paddingTop: 16,
              paddingBottom: 16 + viewport.overscan.y,
            }
          : null,
        {
          backgroundColor: theme.colors.glassBg,
          borderTopColor: theme.colors.glassBorder,
        },
        webBackdropBlur(20),
      ]}
    >
      <View style={[styles.headerRow, { borderBottomColor: theme.colors.surfaceBorder }]}>
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
        {showPrograms ? (
          <View testID="player-program-column" style={styles.column}>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('player.tracks.program')}
            </Text>
            <ScrollView ref={programScrollRef} focusable={!isTv} style={listStyle}>
              {programs.map((program, idx) => (
                <TrackRow
                  key={program.id}
                  testID={`player-program-track-${program.id}`}
                  label={formatProgramLabel(program, i18n)}
                  selected={tracks.selectedProgramId === program.id}
                  tvFocused={showCursor && cursor.column === 'program' && cursor.index === idx}
                  isTv={isTv}
                  isTouch={isTouch}
                  onPress={() => onSelectProgram?.(program.id)}
                />
              ))}
            </ScrollView>
          </View>
        ) : null}

        {displayTracks.audio.length > 0 ? (
          <View testID="player-audio-column" style={styles.column}>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('player.audioTracks')}
            </Text>
            <ScrollView ref={audioScrollRef} focusable={!isTv} style={listStyle}>
              {displayTracks.audio.map((track, idx) => {
                const label = formatTrackLabel(track, idx, displayTracks.audio, i18n);
                return (
                  <TrackRow
                    key={track.id}
                    testID={`player-audio-track-${track.id}`}
                    label={label}
                    selected={displayTracks.selectedAudioId === track.id}
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
            {subtitleEntries.map((entry, idx) => {
              const tvFocused = showCursor && cursor.column === 'subtitles' && cursor.index === idx;
              if (entry.kind === 'primaryOff') {
                return (
                  <TrackRow
                    key="primary-off"
                    testID="player-subtitle-off"
                    label={offLabel}
                    selected={offSelected}
                    tvFocused={tvFocused}
                    isTv={isTv}
                    isTouch={isTouch}
                    onPress={() => onSelectSubtitle(null)}
                  />
                );
              }
              if (entry.kind === 'primaryTrack') {
                const label = formatTrackLabel(
                  entry.track,
                  entry.trackIndex,
                  displayTracks.subtitles,
                  i18n,
                );
                return (
                  <TrackRow
                    key={`primary-${entry.track.id}`}
                    testID={`player-subtitle-track-${entry.track.id}`}
                    label={label}
                    selected={displayTracks.selectedSubtitleId === entry.track.id}
                    {...(entry.track.external === true
                      ? {
                          badgeLabel: externalBadge,
                          badgeTestID: `player-subtitle-external-badge-${entry.track.id}`,
                        }
                      : {})}
                    tvFocused={tvFocused}
                    isTv={isTv}
                    isTouch={isTouch}
                    onPress={() => onSelectSubtitle(entry.track.id)}
                  />
                );
              }
              if (entry.kind === 'secondaryOff') {
                return (
                  <Fragment key="secondary-off">
                    <Text
                      testID="player-secondary-subtitle-header"
                      style={[
                        theme.typography.caption,
                        styles.subSectionHeader,
                        { color: theme.colors.textSecondary },
                      ]}
                    >
                      {i18n.t('player.secondarySubtitleTracks')}
                    </Text>
                    <TrackRow
                      testID="player-secondary-subtitle-off"
                      label={offLabel}
                      selected={secondaryOffSelected}
                      tvFocused={tvFocused}
                      isTv={isTv}
                      isTouch={isTouch}
                      onPress={() => onSelectSecondarySubtitle?.(null)}
                    />
                  </Fragment>
                );
              }
              if (entry.kind === 'secondaryTrack') {
                const label = formatTrackLabel(
                  entry.track,
                  entry.trackIndex,
                  displayTracks.subtitles,
                  i18n,
                );
                return (
                  <TrackRow
                    key={`secondary-${entry.track.id}`}
                    testID={`player-secondary-subtitle-track-${entry.track.id}`}
                    label={label}
                    selected={
                      !entry.disabled &&
                      displayTracks.selectedSecondarySubtitleId === entry.track.id
                    }
                    disabled={entry.disabled}
                    {...(entry.track.external === true
                      ? {
                          badgeLabel: externalBadge,
                          badgeTestID: `player-secondary-subtitle-external-badge-${entry.track.id}`,
                        }
                      : {})}
                    {...(entry.disabled
                      ? {
                          disabledHint: sameAsPrimaryHint,
                          disabledHintTestID: `player-secondary-subtitle-primary-hint-${entry.track.id}`,
                        }
                      : {})}
                    tvFocused={tvFocused}
                    isTv={isTv}
                    isTouch={isTouch}
                    onPress={() => onSelectSecondarySubtitle?.(entry.track.id)}
                  />
                );
              }
              const isFirstExternal = idx === firstExternalIdx;
              const isPick = entry.kind === 'pickSubtitleFile';
              return (
                <Fragment key={entry.kind}>
                  {isFirstExternal ? (
                    <Text
                      testID="player-external-subtitle-header"
                      style={[
                        theme.typography.caption,
                        styles.subSectionHeader,
                        { color: theme.colors.textSecondary },
                      ]}
                    >
                      {i18n.t('player.externalSubtitle.load')}
                    </Text>
                  ) : null}
                  <TrackRow
                    testID={
                      isPick
                        ? 'player-external-subtitle-pick-file'
                        : 'player-external-subtitle-from-url'
                    }
                    label={i18n.t(
                      isPick
                        ? 'player.externalSubtitle.pickFile'
                        : 'player.externalSubtitle.fromUrl',
                    )}
                    selected={false}
                    role="button"
                    tvFocused={tvFocused}
                    isTv={isTv}
                    isTouch={isTouch}
                    onPress={() => {
                      if (isPick) onPickSubtitleFile?.();
                      else onLoadSubtitleUrl?.();
                    }}
                  />
                </Fragment>
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
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
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
  subSectionHeader: {
    marginTop: 6,
    marginBottom: 4,
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
  optionText: {
    flex: 1,
  },
});
