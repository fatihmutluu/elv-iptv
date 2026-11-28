import type { NowNextEntry } from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import {
  type ClockAnchor,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackState,
  positionAt,
} from '@elv/playback';
import { MicroPill, TABULAR_NUMS_STYLE, useTheme, useViewport, webBackdropBlur } from '@elv/ui-kit';
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useCatalogUiCache } from '../shared/CatalogUiCacheProvider';
import {
  buildStreamQualityBadges,
  computeProgrammeProgress,
  formatProgrammeWindow,
} from './player-info-model';
import { formatStatsHudLines } from './player-overlay-model';
import { usePlaybackTicker } from './usePlaybackTicker';

const FONT_FAMILY_MONO = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  web: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  default: 'monospace',
});
const ROW_KEYS = ['status', 'tracks', 'telemetry', 'diagnostics'] as const;
const UI_STALL_FRAME_MS = 50;

/** Props of {@link PlayerStatsHud}. */
export interface PlayerStatsHudProps {
  readonly visible: boolean;
  /** Whether the player OSD top bar is currently visible so the HUD offsets cleanly below it. */
  readonly osdVisible?: boolean;
  readonly service: PlaybackService | null;
  readonly clock: PlaybackClock;
  readonly i18n: AppI18n;
  readonly isDesktop: boolean;
  readonly docked?: boolean;
  /** Stream title merged from legacy programme info sheet (`Wave R4`). */
  readonly title?: string | undefined;
  /** Optional VOD subtitle/episode context merged into the HUD (`Wave R4`). */
  readonly subtitle?: string | null | undefined;
  readonly isVod?: boolean | undefined;
  /** Optional Live EPG Now/Next window displayed above playback telemetry (`Wave R4`). */
  readonly nowNext?: NowNextEntry | null | undefined;
  /** Wall-clock Unix epoch ms used to compute live EPG progress (`Date.now()`). */
  readonly nowMs?: number | undefined;
}

const sameBucket = (a: number, b: number): boolean => a === b;
const readSecondBucket = (anchor: ClockAnchor | undefined, nowMs: number): number =>
  anchor === undefined ? -1 : Math.floor(Math.max(0, positionAt(anchor, nowMs)) / 1000);

const sameMeta = (a: PlaybackState | undefined, b: PlaybackState): boolean =>
  a !== undefined &&
  a.status === b.status &&
  a.tracks === b.tracks &&
  a.videoInfo === b.videoInfo &&
  a.droppedFrames === b.droppedFrames &&
  a.attempt === b.attempt &&
  a.firstFrameAt === b.firstFrameAt &&
  a.tuneAt === b.tuneAt &&
  a.staleEventsDropped === b.staleEventsDropped;

function PlayerStatsHudBody(props: Omit<PlayerStatsHudProps, 'visible'>): ReactElement | null {
  const { service, clock, i18n, isDesktop, docked = isDesktop } = props;
  const theme = useTheme();
  const viewport = useViewport();
  const uiCache = useCatalogUiCache();
  const [meta, setMeta] = useState<PlaybackState | undefined>(() => service?.getState());
  const [uiStalls, setUiStalls] = useState(0);
  const lastFrameRef = useRef<number | null>(null);

  useEffect(() => {
    setMeta(service?.getState());
    if (service === null) return;
    return service.subscribe((next) => setMeta((prev) => (sameMeta(prev, next) ? prev : next)));
  }, [service]);

  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function' || typeof cancelAnimationFrame !== 'function') {
      return;
    }
    let handle = 0;
    let cancelled = false;
    lastFrameRef.current = null;
    const step = (ts: number): void => {
      if (cancelled) return;
      if (lastFrameRef.current !== null && ts - lastFrameRef.current > UI_STALL_FRAME_MS) {
        setUiStalls((n) => n + 1);
      }
      lastFrameRef.current = ts;
      handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(handle);
    };
  }, []);

  const secondBucket = usePlaybackTicker({
    service,
    clock,
    mode: 'second',
    derive: readSecondBucket,
    isEqual: sameBucket,
  });

  const live = service?.getState() ?? meta;
  const cacheHitRatePct = uiCache?.getMetrics?.().hitRatePct;
  // biome-ignore lint/correctness/useExhaustiveDependencies: secondBucket triggers 1Hz formatting once per tick
  const lines = useMemo(
    () =>
      live !== undefined
        ? formatStatsHudLines(live, clock.now(), i18n, {
            cacheHitRatePct,
            uiStalls,
          })
        : [],
    [cacheHitRatePct, clock, i18n, live, secondBucket, uiStalls],
  );
  if (live === undefined || lines.length === 0) return null;

  const qualityBadges = buildStreamQualityBadges(live.videoInfo, live.tracks, i18n);
  const nowProg = props.isVod !== true ? (props.nowNext?.now ?? null) : null;
  const nextProg = props.isVod !== true ? (props.nowNext?.next ?? null) : null;
  const currentWallMs = props.nowMs ?? Date.now();
  const hasProgrammeContext =
    nowProg !== null ||
    props.isVod === false ||
    (props.title !== undefined && props.title.trim().length > 0);
  const nowWindow = nowProg !== null ? formatProgrammeWindow(nowProg.start, nowProg.stop) : '';
  const nowPct =
    nowProg !== null ? computeProgrammeProgress(nowProg.start, nowProg.stop, currentWallMs) : 0;
  const trimmedSubtitle = props.subtitle?.trim();

  const isDockedBar = isDesktop && docked;
  const boxStyle = {
    backgroundColor: theme.colors.glassBg,
    borderColor: theme.colors.glassBorder,
    borderRadius: isDockedBar ? 0 : theme.radius.card,
  };
  const topOffset = props.osdVisible === true ? 96 : 16;
  const overlayStyle = isDockedBar
    ? styles.desktopDock
    : {
        position: 'absolute' as const,
        top: topOffset + viewport.safeArea.top + viewport.overscan.y,
        left: 16 + viewport.safeArea.left + viewport.overscan.x,
        right: 16 + viewport.safeArea.right + viewport.overscan.x,
        zIndex: 25,
        maxWidth: 500,
      };

  return (
    <View
      testID="player-stats-hud"
      pointerEvents="none"
      style={[styles.pill, overlayStyle, boxStyle, webBackdropBlur(16)]}
    >
      {hasProgrammeContext ? (
        <View
          testID="player-stats-programme"
          style={[styles.programmeSection, { borderBottomColor: theme.colors.surfaceBorder }]}
        >
          {nowProg !== null ? (
            <>
              <View style={styles.nowHeaderRow}>
                <Text style={[theme.typography.micro, { color: theme.colors.accent }]}>
                  {i18n.t('player.nowPlaying')}
                </Text>
                {nowWindow.length > 0 ? (
                  <Text
                    testID="player-stats-now-window"
                    style={[
                      theme.typography.caption,
                      TABULAR_NUMS_STYLE,
                      { color: theme.colors.textMuted },
                    ]}
                  >
                    {nowWindow}
                  </Text>
                ) : null}
              </View>
              <Text
                testID="player-stats-now-title"
                numberOfLines={1}
                style={[theme.typography.title, { color: theme.colors.textPrimary }]}
              >
                {nowProg.title}
              </Text>
              <View
                testID="player-stats-progress"
                style={[styles.progressTrack, { backgroundColor: theme.colors.actionGlassBorder }]}
              >
                <View
                  testID="player-stats-progress-fill"
                  style={[
                    styles.progressFill,
                    { width: `${nowPct}%`, backgroundColor: theme.colors.accent },
                  ]}
                />
              </View>
              {nowProg.description != null && nowProg.description.trim().length > 0 ? (
                <Text
                  testID="player-stats-now-desc"
                  numberOfLines={2}
                  style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                >
                  {nowProg.description.trim()}
                </Text>
              ) : null}
              {nextProg !== null ? (
                <Text
                  testID="player-stats-up-next"
                  numberOfLines={1}
                  style={[theme.typography.caption, { color: theme.colors.textMuted }]}
                >
                  {`${i18n.t('player.upNext')}: ${nextProg.title}`}
                </Text>
              ) : null}
            </>
          ) : props.isVod === true ||
            (props.title !== undefined && props.title.trim().length > 0) ? (
            <>
              {props.title !== undefined && props.title.trim().length > 0 ? (
                <Text
                  testID="player-stats-title"
                  numberOfLines={1}
                  style={[theme.typography.title, { color: theme.colors.textPrimary }]}
                >
                  {props.title}
                </Text>
              ) : null}
              {trimmedSubtitle !== undefined && trimmedSubtitle.length > 0 ? (
                <Text
                  testID="player-stats-subtitle"
                  numberOfLines={1}
                  style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                >
                  {trimmedSubtitle}
                </Text>
              ) : props.isVod === false ? (
                <Text
                  testID="player-stats-no-programme"
                  numberOfLines={1}
                  style={[theme.typography.caption, { color: theme.colors.textMuted }]}
                >
                  {i18n.t('player.noProgrammeInfo')}
                </Text>
              ) : null}
            </>
          ) : (
            <Text
              testID="player-stats-no-programme"
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.textMuted }]}
            >
              {i18n.t('player.noProgrammeInfo')}
            </Text>
          )}
        </View>
      ) : null}

      {qualityBadges.length > 0 ? (
        <View
          testID="player-stats-quality"
          style={[styles.badgesRow, { borderBottomColor: theme.colors.surfaceBorder }]}
        >
          {qualityBadges.map((badge) => (
            <MicroPill
              key={badge.key}
              testID={`player-stats-badge-${badge.key}`}
              label={badge.label}
              tone={badge.tone}
            />
          ))}
        </View>
      ) : null}

      <View testID="player-stats-telemetry" style={styles.telemetryList}>
        {lines.map((line, idx) => (
          <Text
            key={ROW_KEYS[idx] ?? line}
            numberOfLines={1}
            style={[
              TABULAR_NUMS_STYLE,
              styles.line,
              {
                fontFamily: FONT_FAMILY_MONO,
                color: idx === 0 ? theme.colors.textPrimary : theme.colors.textSecondary,
              },
            ]}
          >
            {line}
          </Text>
        ))}
      </View>
    </View>
  );
}

/**
 * Merged Programme Info, Decoded Stream Quality, and Monospace Telemetry HUD (`Wave R4`):
 * mounts `usePlaybackTicker` and frame-stall meter strictly while `visible` is `true`
 * and docks cleanly below the video stage in child-HWND desktop mode.
 */
export function PlayerStatsHud(props: PlayerStatsHudProps): ReactElement | null {
  return props.visible ? <PlayerStatsHudBody {...props} /> : null;
}

const styles = StyleSheet.create({
  pill: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  desktopDock: { borderWidth: 0, borderTopWidth: 1, paddingHorizontal: 16 },
  programmeSection: {
    gap: 4,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  nowHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  progressTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%' },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  telemetryList: { gap: 2 },
  line: { fontSize: 11.5, lineHeight: 16 },
});
