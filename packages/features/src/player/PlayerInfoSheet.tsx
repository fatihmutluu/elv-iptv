import type { NowNextEntry } from '@elv/data';
import { type AppI18n, resolveLanguageLabel } from '@elv/i18n';
import type { MediaTracks, StreamVideoInfo } from '@elv/playback';
import {
  AdaptiveSheet,
  type FormFactor,
  IconButton,
  MicroPill,
  type MicroPillTone,
  TABULAR_NUMS_STYLE,
  useTheme,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ComponentRef, type ReactElement, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useDesktopDialogTrap } from './desktop-dialog-trap';

/** Alias for live Now/Next programme metadata from `@elv/data`. */
type EpgNowNextEntry = NowNextEntry;

/** Single quality badge derived strictly from live stream telemetry and tracks. */
export interface StreamQualityBadge {
  readonly key: string;
  readonly label: string;
  readonly tone: MicroPillTone;
}

/** Props of {@link PlayerInfoSheet}. */
export interface PlayerInfoSheetProps {
  readonly visible: boolean;
  readonly title: string;
  readonly subtitle?: string | null | undefined;
  readonly isVod: boolean;
  readonly nowNext?: EpgNowNextEntry | null | undefined;
  readonly videoInfo?: StreamVideoInfo | undefined;
  readonly tracks: MediaTracks;
  readonly formFactor: FormFactor;
  readonly isTv: boolean;
  readonly i18n: AppI18n;
  readonly nowMs?: number;
  readonly onClose: () => void;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Formats a local `HH:MM–HH:MM` broadcast window for EPG display. */
export function formatProgrammeWindow(startMs: number, stopMs: number): string {
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) return '';
  const s = new Date(startMs);
  const e = new Date(stopMs);
  return `${pad2(s.getHours())}:${pad2(s.getMinutes())}–${pad2(e.getHours())}:${pad2(e.getMinutes())}`;
}

/** Computes clamped `[0, 100]` percentage progress across a live programme window. */
export function computeProgrammeProgress(startMs: number, stopMs: number, nowMs: number): number {
  const span = stopMs - startMs;
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(nowMs)) return 0;
  return Math.round(Math.max(0, Math.min(1, (nowMs - startMs) / span)) * 1000) / 10;
}

function formatResolution(w?: number, h?: number): string | null {
  const height = typeof h === 'number' && Number.isFinite(h) && h > 0 ? Math.round(h) : 0;
  const width = typeof w === 'number' && Number.isFinite(w) && w > 0 ? Math.round(w) : 0;
  if (height <= 0 && width <= 0) return null;
  const tier =
    height >= 2160 || width >= 3840
      ? '4K'
      : height >= 1440 || width >= 2560
        ? '1440p'
        : height >= 1080 || width >= 1920
          ? '1080p'
          : height >= 720 || width >= 1280
            ? '720p'
            : height > 0
              ? `${height}p`
              : `${width}w`;
  return width > 0 && height > 0 ? `${tier} · ${width}×${height}` : tier;
}

function formatFps(fps?: number): string | null {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return null;
  const rounded = Math.round(fps);
  return `${Math.abs(fps - rounded) < 0.01 ? String(rounded) : fps.toFixed(2)} fps`;
}

function formatChannelLayout(channels?: number): string | undefined {
  if (channels === undefined || !Number.isFinite(channels) || channels <= 0) return undefined;
  if (channels === 1) return '1.0';
  if (channels === 2) return '2.0';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels}ch`;
}

/**
 * Derives compact `MicroPill` stream quality badges strictly from real `StreamVideoInfo`
 * and active `MediaTracks` selections (never fabricating fallback values).
 */
export function buildStreamQualityBadges(
  videoInfo: StreamVideoInfo | undefined,
  tracks: MediaTracks,
  i18n: AppI18n,
): readonly StreamQualityBadge[] {
  const badges: StreamQualityBadge[] = [];
  const res = formatResolution(videoInfo?.width, videoInfo?.height);
  if (res !== null) {
    const uhd = (videoInfo?.height ?? 0) >= 2160 || (videoInfo?.width ?? 0) >= 3840;
    badges.push({ key: 'resolution', label: res, tone: uhd ? 'accent' : 'neutral' });
  }
  const fps = formatFps(videoInfo?.fps);
  if (fps !== null) badges.push({ key: 'fps', label: fps, tone: 'neutral' });
  const codec = videoInfo?.codec?.trim();
  if (codec) badges.push({ key: 'vcodec', label: codec.toUpperCase(), tone: 'neutral' });
  if (videoInfo?.hdr === 'hdr10') badges.push({ key: 'hdr', label: 'HDR10', tone: 'accent' });
  else if (videoInfo?.hdr === 'dv') badges.push({ key: 'hdr', label: 'DV', tone: 'accent' });
  else if (videoInfo?.hdr === 'hlg') badges.push({ key: 'hdr', label: 'HLG', tone: 'accent' });

  const audio = tracks.audio.find((t) => t.id === tracks.selectedAudioId);
  if (audio !== undefined) {
    const ac = audio.codec?.trim();
    const parts = [ac ? ac.toUpperCase() : undefined, formatChannelLayout(audio.channels)].filter(
      (p): p is string => p !== undefined,
    );
    const label =
      parts.length > 0
        ? parts.join(' ')
        : (resolveLanguageLabel(audio.language, i18n) ??
          audio.label?.trim() ??
          audio.language?.trim());
    if (label) badges.push({ key: 'audio', label, tone: 'neutral' });
  }
  const sub = tracks.subtitles.find((t) => t.id === tracks.selectedSubtitleId);
  if (sub !== undefined) {
    const lang =
      resolveLanguageLabel(sub.language, i18n) ?? sub.label?.trim() ?? sub.language?.trim();
    if (lang) {
      badges.push({
        key: 'subtitle',
        label: `${i18n.t('player.subtitleTracks')}: ${lang}`,
        tone: 'neutral',
      });
    }
  }
  return badges;
}

/**
 * Non-blocking Cinema Quietude v2 Programme & Stream Info sheet (`#58`).
 * Flex-docked in normal flow on `desktop` (HWND-safe) and wrapped in `AdaptiveSheet` elsewhere.
 */
export function PlayerInfoSheet({
  visible,
  title,
  subtitle,
  isVod,
  nowNext,
  videoInfo,
  tracks,
  formFactor,
  isTv,
  i18n,
  nowMs,
  onClose,
}: PlayerInfoSheetProps): ReactElement | null {
  const theme = useTheme();
  const isWebDesktop = formFactor === 'desktop' && (Platform.OS as string) === 'web';
  const desktopPanelRef = useRef<ComponentRef<typeof View> | null>(null);
  useDesktopDialogTrap(desktopPanelRef, visible && isWebDesktop, onClose, {
    modal: false,
    initialFocus: 'container',
  });
  if (!visible) return null;

  const headerTitle = i18n.t('player.info');
  const trimmedSubtitle = subtitle?.trim();
  const nowProg = !isVod ? (nowNext?.now ?? null) : null;
  const nextProg = !isVod ? (nowNext?.next ?? null) : null;
  const progressPct =
    nowProg !== null
      ? computeProgrammeProgress(nowProg.start, nowProg.stop, nowMs ?? Date.now())
      : 0;
  const badges = buildStreamQualityBadges(videoInfo, tracks, i18n);

  const content = (
    <View testID="player-info-panel" style={styles.inner}>
      <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
        <Text
          numberOfLines={1}
          style={[theme.typography.h2, styles.flex1, { color: theme.colors.textPrimary }]}
        >
          {headerTitle}
        </Text>
        <IconButton
          testID="player-info-close"
          icon="close"
          size={36}
          accessibilityLabel={i18n.t('player.closeTracks')}
          focusable={!isTv}
          onPress={onClose}
        />
      </View>

      <View testID="player-info-programme" style={styles.section}>
        {nowProg !== null ? (
          <>
            <View style={styles.rowBetween}>
              <MicroPill label={i18n.t('player.nowPlaying')} tone="live" />
              <Text
                testID="player-info-now-window"
                style={[
                  theme.typography.caption,
                  TABULAR_NUMS_STYLE,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {formatProgrammeWindow(nowProg.start, nowProg.stop)}
              </Text>
            </View>
            <Text
              numberOfLines={2}
              style={[theme.typography.title, { color: theme.colors.textPrimary }]}
            >
              {nowProg.title}
            </Text>
            {nowProg.subTitle?.trim() ? (
              <Text
                numberOfLines={1}
                style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
              >
                {nowProg.subTitle.trim()}
              </Text>
            ) : null}
            <View
              testID="player-info-progress"
              style={[styles.progressTrack, { backgroundColor: theme.colors.bgCard }]}
            >
              <View
                testID="player-info-progress-fill"
                style={[
                  styles.progressFill,
                  { width: `${progressPct}%`, backgroundColor: theme.colors.accent },
                ]}
              />
            </View>
            {nowProg.description?.trim() ? (
              <Text
                numberOfLines={4}
                style={[theme.typography.body, { color: theme.colors.textSecondary }]}
              >
                {nowProg.description.trim()}
              </Text>
            ) : null}
            {nextProg !== null ? (
              <View
                testID="player-info-up-next"
                style={[styles.upNextBox, { borderTopColor: theme.colors.surfaceBorder }]}
              >
                <View style={styles.rowBetween}>
                  <Text style={[theme.typography.micro, { color: theme.colors.textMuted }]}>
                    {i18n.t('player.upNext')}
                  </Text>
                  <Text
                    style={[
                      theme.typography.caption,
                      TABULAR_NUMS_STYLE,
                      { color: theme.colors.textMuted },
                    ]}
                  >
                    {formatProgrammeWindow(nextProg.start, nextProg.stop)}
                  </Text>
                </View>
                <Text
                  numberOfLines={1}
                  style={[theme.typography.caption, { color: theme.colors.textPrimary }]}
                >
                  {nextProg.title}
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <>
            <Text
              numberOfLines={2}
              style={[theme.typography.title, { color: theme.colors.textPrimary }]}
            >
              {title}
            </Text>
            {trimmedSubtitle ? (
              <Text
                numberOfLines={2}
                style={[theme.typography.body, { color: theme.colors.textSecondary }]}
              >
                {trimmedSubtitle}
              </Text>
            ) : null}
            {!isVod ? (
              <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
                {i18n.t('player.noProgrammeInfo')}
              </Text>
            ) : null}
          </>
        )}
      </View>

      {badges.length > 0 ? (
        <View
          testID="player-info-quality"
          style={[styles.qualitySection, { borderTopColor: theme.colors.surfaceBorder }]}
        >
          <Text style={[theme.typography.micro, { color: theme.colors.textMuted }]}>
            {i18n.t('player.streamQuality')}
          </Text>
          <View style={styles.badgeRow}>
            {badges.map((badge) => (
              <MicroPill
                key={badge.key}
                testID={`player-info-badge-${badge.key}`}
                label={badge.label}
                tone={badge.tone}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );

  if (formFactor === 'desktop') {
    const dialogProps = {
      onKeyDown: (e: {
        key?: string;
        preventDefault?: () => void;
        stopPropagation?: () => void;
      }) => {
        if (e.key !== 'Escape') return;
        e.preventDefault?.();
        e.stopPropagation?.();
        onClose();
      },
      ...(isWebDesktop ? { role: 'dialog', 'aria-modal': false, 'aria-label': headerTitle } : {}),
    } as Record<string, unknown>;
    return (
      <View
        ref={desktopPanelRef}
        testID="player-info-desktop-dialog"
        {...dialogProps}
        style={[
          styles.desktopPanel,
          { backgroundColor: theme.colors.glassBg, borderTopColor: theme.colors.glassBorder },
          webBackdropBlur(20),
        ]}
      >
        {content}
      </View>
    );
  }

  return (
    <AdaptiveSheet
      visible={visible}
      onDismiss={onClose}
      testID="player-info-sheet"
      popoverWidth={340}
    >
      {content}
    </AdaptiveSheet>
  );
}

const styles = StyleSheet.create({
  desktopPanel: { borderTopWidth: 1, paddingHorizontal: 18, paddingVertical: 12 },
  inner: { gap: 12 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  flex1: { flex: 1 },
  section: { gap: 6 },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  progressTrack: { height: 3, borderRadius: 999, overflow: 'hidden', marginVertical: 2 },
  progressFill: { height: '100%' },
  upNextBox: { marginTop: 4, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 3 },
  qualitySection: { paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, gap: 8 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
