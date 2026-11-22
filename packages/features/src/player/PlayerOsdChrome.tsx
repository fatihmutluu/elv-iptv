import type { NowNextEntry } from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import {
  EMPTY_TRACKS,
  type MediaTracks,
  type PlaybackClock,
  type PlaybackService,
  type StreamVideoInfo,
} from '@elv/playback';
import { Icon, MicroPill, Scrim, TABULAR_NUMS_STYLE, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DescribedPlaybackFailure } from './errors';
import { computeProgrammeProgress } from './PlayerInfoSheet';
import { formatStreamBadges } from './player-overlay-model';
import { formatPlaybackSpeed } from './settings-menu-nav';
import { VodProgressBar } from './VodProgressBar';

/** Shared Cinema Quietude error hint + redacted diagnosis evidence box. */
export function PlayerFailureBanner({
  failure,
  i18n,
  compact = false,
}: {
  readonly failure: DescribedPlaybackFailure;
  readonly i18n: AppI18n;
  readonly compact?: boolean;
}): ReactElement {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.errorBox,
        {
          paddingVertical: compact ? 6 : 8,
          backgroundColor: theme.colors.scrimStrong,
          borderColor: theme.colors.liveColor,
          borderRadius: theme.radius.card,
        },
      ]}
    >
      <Icon name="warning" size={16} color={theme.colors.liveColor} />
      <View style={styles.flex1}>
        <Text
          testID="osd-error-hint"
          style={[theme.typography.caption, { color: theme.colors.textPrimary }]}
        >
          {i18n.t(failure.hintId)}
        </Text>
        {failure.httpStatus !== undefined ? (
          <Text
            testID="player-error-http-status"
            numberOfLines={1}
            style={[
              theme.typography.caption,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textSecondary },
            ]}
          >
            {i18n.t('player.error.httpStatus', { status: failure.httpStatus })}
          </Text>
        ) : null}
        {failure.evidence !== undefined && failure.evidence.trim().length > 0 ? (
          <Text
            testID="player-error-evidence"
            numberOfLines={1}
            style={[theme.typography.caption, { color: theme.colors.textMuted }]}
          >
            {failure.evidence}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Renders compact outlined `MicroPill` stream quality badges derived from real decoded telemetry (`#58`). */
export function StreamBadgePills({
  videoInfo,
  tracks,
}: {
  readonly videoInfo: StreamVideoInfo | undefined;
  readonly tracks: MediaTracks | undefined;
}): ReactElement | null {
  const badges = formatStreamBadges(videoInfo, tracks ?? EMPTY_TRACKS);
  if (badges.length === 0) return null;
  return (
    <>
      {badges.map((badge) => (
        <MicroPill
          key={badge.key}
          testID={`player-stream-badge-${badge.key}`}
          label={badge.label}
          tone={badge.tone ?? 'neutral'}
        />
      ))}
    </>
  );
}

/** Sleek Live Now & Next programme progress strip for TV / mobile / peek overlays (`#58`). */
export function LiveNowNextStrip({
  nowNext,
  nowMs,
  i18n,
  compact = false,
}: {
  readonly nowNext: NowNextEntry | null | undefined;
  readonly nowMs: number;
  readonly i18n: AppI18n;
  readonly compact?: boolean;
}): ReactElement | null {
  const theme = useTheme();
  const nowProg = nowNext?.now ?? null;
  const nextProg = nowNext?.next ?? null;
  if (nowProg === null) return null;
  const progressPct = computeProgrammeProgress(nowProg.start, nowProg.stop, nowMs);

  return (
    <View testID="player-live-now-next" style={compact ? styles.nowNextCompact : styles.nowNextBox}>
      <View style={styles.rowBetween}>
        <Text
          testID="osd-now-programme"
          numberOfLines={1}
          style={[
            theme.typography.caption,
            styles.titleShrink,
            { color: theme.colors.textPrimary, fontWeight: '600' },
          ]}
        >
          {`${i18n.t('player.nowPlaying')} · ${nowProg.title}`}
        </Text>
        {!compact && nextProg !== null ? (
          <Text
            testID="osd-next-programme"
            numberOfLines={1}
            style={[
              theme.typography.caption,
              styles.nextText,
              { color: theme.colors.textSecondary },
            ]}
          >
            {`${i18n.t('player.upNext')}: ${nextProg.title}`}
          </Text>
        ) : null}
      </View>
      <View
        testID="osd-now-progress"
        style={[
          compact ? styles.nowProgTrackCompact : styles.nowProgTrack,
          { backgroundColor: theme.colors.bgCard },
        ]}
      >
        <View
          style={[
            styles.nowProgFill,
            { width: `${progressPct}%`, backgroundColor: theme.colors.accent },
          ]}
        />
      </View>
    </View>
  );
}

/** Shared props for the lightweight `'progress'` peek tier (`#391`). */
export interface PeekBarProps {
  readonly title: string;
  readonly channelDigits?: string | undefined;
  readonly isVod: boolean;
  readonly isTv: boolean;
  readonly muted: boolean;
  readonly volume: number;
  readonly playbackSpeed: number;
  readonly nowNext?: NowNextEntry | null | undefined;
  readonly nowMs?: number | undefined;
  readonly previewPositionMs?: number | undefined;
  readonly service: PlaybackService | null;
  readonly clock: PlaybackClock;
  readonly i18n: AppI18n;
  readonly onSeekRatio: (ratio: number) => void;
  readonly onScrubbingChange?: ((scrubbing: boolean) => void) | undefined;
}

/** Flex-docked desktop `'progress'` peek strip (`#391`, `#394`) — never overlaps native HWND. */
export function DesktopPeekStrip(p: PeekBarProps): ReactElement {
  const theme = useTheme();
  const displayedVol = p.muted ? 0 : p.volume;
  const nowProg = !p.isVod ? (p.nowNext?.now ?? null) : null;

  return (
    <View testID="player-osd-progress-peek" style={styles.peekWrap}>
      {p.isVod ? (
        <>
          <VodProgressBar
            service={p.service}
            clock={p.clock}
            isTv={false}
            docked
            label={p.i18n.t('player.progressLabel')}
            previewPositionMs={p.previewPositionMs}
            onSeekRatio={p.onSeekRatio}
            {...(p.onScrubbingChange !== undefined
              ? { onScrubbingChange: p.onScrubbingChange }
              : {})}
          />
          <View style={styles.rowBetween}>
            <Text
              testID="osd-title"
              numberOfLines={1}
              style={[
                theme.typography.caption,
                styles.titleShrink,
                { color: theme.colors.textSecondary },
              ]}
            >
              {p.title}
            </Text>
            <View style={styles.peekRight}>
              {p.playbackSpeed !== 1 ? (
                <MicroPill
                  testID="player-peek-speed"
                  label={formatPlaybackSpeed(p.playbackSpeed)}
                  tone="accent"
                />
              ) : null}
              <Text
                testID="player-peek-volume"
                style={[
                  theme.typography.caption,
                  TABULAR_NUMS_STYLE,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {`${p.i18n.t('player.volume')} ${displayedVol}%`}
              </Text>
            </View>
          </View>
        </>
      ) : (
        <View style={styles.rowBetween}>
          <View style={styles.titleRow}>
            <Text
              testID="osd-title"
              numberOfLines={1}
              style={[
                theme.typography.title,
                styles.titleShrink,
                { color: theme.colors.textPrimary, fontWeight: '600' },
              ]}
            >
              {p.title}
            </Text>
            <MicroPill testID="player-live-badge" label={p.i18n.t('ui.liveBadge')} tone="live" />
            {p.channelDigits !== undefined && p.channelDigits.length > 0 ? (
              <MicroPill testID="player-channel-digits" label={p.channelDigits} tone="accent" />
            ) : null}
            {nowProg !== null ? (
              <Text
                testID="osd-now-programme"
                numberOfLines={1}
                style={[
                  theme.typography.caption,
                  styles.titleShrink,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {nowProg.title}
              </Text>
            ) : null}
          </View>
          <Text
            testID="player-peek-volume"
            style={[
              theme.typography.caption,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textSecondary },
            ]}
          >
            {`${p.i18n.t('player.volume')} ${displayedVol}%`}
          </Text>
        </View>
      )}
    </View>
  );
}

/** Floating bottom-scrim `'progress'` peek overlay for TV / mobile / tablet (`#391`). */
export function FloatingPeekOsd(
  p: PeekBarProps & {
    readonly padBottom: number;
    readonly padLeft: number;
    readonly padRight: number;
  },
): ReactElement {
  const theme = useTheme();
  return (
    <View testID="player-osd" pointerEvents="box-none" style={styles.floatingPeekRoot}>
      <View
        testID="player-osd-progress-peek"
        style={[
          styles.floatingPeekZone,
          { paddingBottom: p.padBottom, paddingLeft: p.padLeft, paddingRight: p.padRight },
        ]}
      >
        <Scrim direction="bottom" intensity="default" />
        {p.isVod ? (
          <>
            <View style={styles.rowBetween}>
              <Text
                testID="osd-title"
                numberOfLines={1}
                style={[
                  theme.typography.caption,
                  styles.titleShrink,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {p.title}
              </Text>
              {p.playbackSpeed !== 1 ? (
                <MicroPill
                  testID="player-peek-speed"
                  label={formatPlaybackSpeed(p.playbackSpeed)}
                  tone="accent"
                />
              ) : null}
            </View>
            <VodProgressBar
              service={p.service}
              clock={p.clock}
              isTv={p.isTv}
              label={p.i18n.t('player.progressLabel')}
              previewPositionMs={p.previewPositionMs}
              onSeekRatio={p.onSeekRatio}
              {...(p.onScrubbingChange !== undefined
                ? { onScrubbingChange: p.onScrubbingChange }
                : {})}
            />
          </>
        ) : (
          <View style={styles.peekWrap}>
            <View style={styles.titleRow}>
              <Text
                testID="osd-title"
                numberOfLines={1}
                style={[
                  theme.typography.title,
                  styles.titleShrink,
                  { color: theme.colors.textPrimary, fontWeight: '600' },
                ]}
              >
                {p.title}
              </Text>
              <MicroPill testID="player-live-badge" label={p.i18n.t('ui.liveBadge')} tone="live" />
              {p.channelDigits !== undefined && p.channelDigits.length > 0 ? (
                <MicroPill testID="player-channel-digits" label={p.channelDigits} tone="accent" />
              ) : null}
            </View>
            <LiveNowNextStrip nowNext={p.nowNext} nowMs={p.nowMs ?? Date.now()} i18n={p.i18n} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  peekWrap: { gap: 6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minWidth: 0 },
  titleShrink: { flexShrink: 1 },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  peekRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  nowNextBox: { gap: 4 },
  nowNextCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
    minWidth: 0,
  },
  nextText: { flexShrink: 1, maxWidth: '45%' },
  nowProgTrack: { height: 3, borderRadius: 999, overflow: 'hidden', width: '100%' },
  nowProgTrackCompact: {
    width: 56,
    height: 3,
    borderRadius: 999,
    overflow: 'hidden',
    flexShrink: 0,
  },
  nowProgFill: { height: '100%' },
  floatingPeekRoot: { position: 'absolute', inset: 0, justifyContent: 'flex-end' },
  floatingPeekZone: { position: 'relative', paddingTop: 20, gap: 6 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
  },
});
