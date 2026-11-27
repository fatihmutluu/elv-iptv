import type { MediaTracks, StreamVideoInfo, TrackInfo } from '@elv/playback';
import {
  hexToRgba,
  Icon,
  IconButton,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  useTvKeyInterceptor,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { memo, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AudioDeviceInfo } from '../ports/video-host';
import type { LiveSplitOverlayKind } from './LiveSplitPlayerControls';
import type { LiveSplitResizeMode } from './useLiveEmbeddedPreview';

/** Props of {@link LiveSplitPlayerOverlays}. */
export interface LiveSplitPlayerOverlaysProps {
  readonly activeOverlay: LiveSplitOverlayKind;
  readonly docked: boolean;
  readonly isTv: boolean;
  readonly tracks: MediaTracks;
  readonly videoInfo: StreamVideoInfo | undefined;
  readonly resizeMode: LiveSplitResizeMode;
  readonly audioDevices: readonly AudioDeviceInfo[];
  readonly activeAudioDevice: string;
  readonly onSelectAudio: (id: string) => void;
  readonly onSelectSubtitle: (id: string | null) => void;
  readonly onSelectAudioDevice: (name: string) => void;
  readonly onCycleResizeMode: () => void;
  readonly onOpenTracks: () => void;
  readonly onOpenMultiView?: () => void;
  readonly onOpenPopout?: () => void;
  readonly onClose: () => void;
}

interface OverlayOptionRow {
  readonly key: string;
  readonly testID: string;
  readonly label: string;
  readonly value?: string;
  readonly selected?: boolean;
  readonly onPress: () => void;
}

function OverlayTvKeyTrap({
  onInput,
}: {
  readonly onInput: Parameters<typeof useTvKeyInterceptor>[0];
}): null {
  useTvKeyInterceptor(onInput);
  return null;
}

function formatTrackLabel(track: TrackInfo, index: number, fallbackPrefix: string): string {
  if (track.label && track.label.trim().length > 0) return track.label;
  if (track.language && track.language.trim().length > 0) return track.language.toUpperCase();
  return `${fallbackPrefix} ${index + 1}`;
}

function formatStreamVideoInfo(info: StreamVideoInfo | undefined): string | null {
  if (!info) return null;
  const parts: string[] = [];
  if (info.width && info.height) parts.push(`${info.width}×${info.height}`);
  if (info.fps && Number.isFinite(info.fps)) parts.push(`${Math.round(info.fps)} fps`);
  if (info.codec) parts.push(info.codec.toUpperCase());
  if (info.hdr && info.hdr !== 'sdr') parts.push(info.hdr.toUpperCase());
  return parts.length > 0 ? parts.join(' · ') : null;
}

function formatResizeLabel(mode: LiveSplitResizeMode, t: ReturnType<typeof useI18n>['t']): string {
  if (mode === 'cover') return t('player.aspect.fill');
  if (mode === 'stretch') return t('player.aspect.stretch');
  return t('player.aspect.fit');
}

/**
 * In-tree Cinema Quietude panels for `LiveWatchStage` (`tracks` picker and `overflow` settings):
 * never uses RN `<Modal>`, renders in flex-flow when `docked` (HWND-safe desktop), and traps 10-ft
 * TV D-pad input cleanly while open.
 */
export const LiveSplitPlayerOverlays = memo(function LiveSplitPlayerOverlaysInner(
  p: LiveSplitPlayerOverlaysProps,
): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');
  const [focusedIdx, setFocusedIdx] = useState(0);
  const focusedIdxRef = useRef(0);
  focusedIdxRef.current = focusedIdx;

  const trackRows = useMemo<readonly OverlayOptionRow[]>(() => {
    const rows: OverlayOptionRow[] = [];
    p.tracks.audio.forEach((track, idx) => {
      rows.push({
        key: `audio-${track.id}`,
        testID: `live-split-audio-track-${track.id}`,
        label: formatTrackLabel(track, idx, i18n.t('player.audioTracks')),
        selected: p.tracks.selectedAudioId === track.id,
        onPress: () => p.onSelectAudio(track.id),
      });
    });
    rows.push({
      key: 'sub-off',
      testID: 'live-split-subtitle-off',
      label: i18n.t('player.subtitlesOff'),
      selected: p.tracks.selectedSubtitleId === null,
      onPress: () => p.onSelectSubtitle(null),
    });
    p.tracks.subtitles.forEach((track, idx) => {
      rows.push({
        key: `sub-${track.id}`,
        testID: `live-split-subtitle-track-${track.id}`,
        label: formatTrackLabel(track, idx, i18n.t('player.subtitleTracks')),
        selected: p.tracks.selectedSubtitleId === track.id,
        onPress: () => p.onSelectSubtitle(track.id),
      });
    });
    return rows;
  }, [i18n, p.onSelectAudio, p.onSelectSubtitle, p.tracks]);

  const overflowRows = useMemo<readonly OverlayOptionRow[]>(() => {
    const rows: OverlayOptionRow[] = [
      {
        key: 'aspect',
        testID: 'live-split-overflow-aspect',
        label: i18n.t('player.aspect'),
        value: formatResizeLabel(p.resizeMode, i18n.t),
        onPress: p.onCycleResizeMode,
      },
      {
        key: 'tracks',
        testID: 'live-split-overflow-tracks',
        label: i18n.t('player.tracks'),
        onPress: p.onOpenTracks,
      },
    ];
    for (const dev of p.audioDevices) {
      rows.push({
        key: `dev-${dev.name}`,
        testID: `live-split-audio-device-${dev.name}`,
        label: dev.description || dev.name,
        selected: p.activeAudioDevice === dev.name,
        onPress: () => p.onSelectAudioDevice(dev.name),
      });
    }
    if (p.onOpenMultiView !== undefined) {
      rows.push({
        key: 'multiview',
        testID: 'live-split-overflow-multiview',
        label: i18n.t('context.openMultiView'),
        onPress: () => {
          p.onClose();
          p.onOpenMultiView?.();
        },
      });
    }
    if (p.onOpenPopout !== undefined) {
      rows.push({
        key: 'popout',
        testID: 'live-split-overflow-popout',
        label: i18n.t('context.openPopout'),
        onPress: () => {
          p.onClose();
          p.onOpenPopout?.();
        },
      });
    }
    return rows;
  }, [
    i18n,
    p.activeAudioDevice,
    p.audioDevices,
    p.onClose,
    p.onCycleResizeMode,
    p.onOpenMultiView,
    p.onOpenPopout,
    p.onOpenTracks,
    p.onSelectAudioDevice,
    p.resizeMode,
  ]);

  const activeRows = p.activeOverlay === 'tracks' ? trackRows : overflowRows;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset focused index when opening or switching panel
  useEffect(() => {
    focusedIdxRef.current = 0;
    setFocusedIdx(0);
  }, [p.activeOverlay]);

  const handleTvTrap = useCallback(
    (input: Parameters<Parameters<typeof useTvKeyInterceptor>[0]>[0]): boolean => {
      if (input.action !== 'down' && input.action !== 'press') return true;
      if (input.key === 'back' || input.key === 'menu') {
        p.onClose();
        return true;
      }
      if (input.key === 'up') {
        const next = Math.max(0, focusedIdxRef.current - 1);
        focusedIdxRef.current = next;
        setFocusedIdx(next);
        return true;
      }
      if (input.key === 'down') {
        const next = Math.min(Math.max(0, activeRows.length - 1), focusedIdxRef.current + 1);
        focusedIdxRef.current = next;
        setFocusedIdx(next);
        return true;
      }
      if (input.key === 'select') {
        activeRows[focusedIdxRef.current]?.onPress();
        return true;
      }
      return true;
    },
    [activeRows, p.onClose],
  );

  if (p.activeOverlay === null) return null;

  const isTracks = p.activeOverlay === 'tracks';
  const streamInfoSummary = formatStreamVideoInfo(p.videoInfo);

  const renderRow = (row: OverlayOptionRow, flatIndex: number) => {
    const focused = p.isTv && focusedIdx === flatIndex;
    return (
      <Pressable
        key={row.key}
        testID={row.testID}
        accessibilityRole="button"
        accessibilityLabel={row.label}
        accessibilityState={row.selected !== undefined ? { selected: row.selected } : undefined}
        focusable={!p.isTv}
        onPress={row.onPress}
        style={({ pressed }) => [
          styles.row,
          {
            borderRadius: theme.radius.button,
            backgroundColor: focused
              ? theme.colors.focusFill
              : row.selected
                ? theme.colors.accentTint
                : pressed
                  ? theme.colors.subtleHighlight
                  : 'transparent',
            borderWidth: focused ? theme.focus.ringWidth : 1,
            borderColor: focused
              ? theme.colors.focusRingColor
              : row.selected
                ? theme.colors.accent
                : 'transparent',
          },
          cursor,
          transition,
        ]}
      >
        <Text
          numberOfLines={1}
          style={[
            theme.typography.body,
            styles.flex1,
            {
              color: theme.colors.textPrimary,
              fontWeight: row.selected || focused ? '600' : '400',
            },
          ]}
        >
          {row.label}
        </Text>
        {row.value ? (
          <Text
            numberOfLines={1}
            style={[
              theme.typography.caption,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textSecondary },
            ]}
          >
            {row.value}
          </Text>
        ) : null}
        {row.selected ? <Icon name="check" size={16} color={theme.colors.accent} /> : null}
      </Pressable>
    );
  };

  const audioCount = p.tracks.audio.length;

  return (
    <View
      testID={isTracks ? 'live-split-tracks-panel' : 'live-split-overflow-panel'}
      style={[
        p.docked ? styles.panelDocked : styles.panelFloating,
        {
          backgroundColor: p.docked
            ? theme.colors.bgElevated
            : hexToRgba(theme.colors.bgElevated, 0.94),
          borderColor: p.docked ? theme.colors.surfaceBorder : theme.colors.glassBorder,
          borderRadius: p.docked ? 0 : theme.radius.modal,
        },
        p.docked ? undefined : webBackdropBlur(20),
      ]}
    >
      {p.isTv ? <OverlayTvKeyTrap onInput={handleTvTrap} /> : null}
      <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
        <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
          {i18n.t(isTracks ? 'player.tracks' : 'player.settings')}
        </Text>
        <IconButton
          testID={isTracks ? 'live-split-tracks-close' : 'live-split-overflow-close'}
          icon="close"
          accessibilityLabel={i18n.t('player.close')}
          focusable={!p.isTv}
          onPress={p.onClose}
        />
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {isTracks ? (
          <>
            <Text
              style={[
                theme.typography.caption,
                styles.sectionTitle,
                { color: theme.colors.textMuted },
              ]}
            >
              {i18n.t('player.audioTracks')}
            </Text>
            {audioCount > 0 ? (
              trackRows.slice(0, audioCount).map((row, i) => renderRow(row, i))
            ) : (
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {i18n.t('player.stats.audioNone')}
              </Text>
            )}
            <Text
              style={[
                theme.typography.caption,
                styles.sectionTitle,
                styles.sectionGap,
                { color: theme.colors.textMuted },
              ]}
            >
              {i18n.t('player.subtitleTracks')}
            </Text>
            {trackRows.slice(audioCount).map((row, i) => renderRow(row, audioCount + i))}
          </>
        ) : (
          <>
            {streamInfoSummary !== null ? (
              <View
                testID="live-split-stream-info"
                style={[
                  styles.infoStrip,
                  {
                    backgroundColor: theme.colors.bgSurface,
                    borderColor: theme.colors.surfaceBorder,
                    borderRadius: theme.radius.button,
                  },
                ]}
              >
                <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
                  {i18n.t('player.streamQuality')}
                </Text>
                <Text
                  style={[
                    theme.typography.body,
                    TABULAR_NUMS_STYLE,
                    { color: theme.colors.textPrimary, fontWeight: '600' },
                  ]}
                >
                  {streamInfoSummary}
                </Text>
              </View>
            ) : null}
            {overflowRows.map((row, idx) => renderRow(row, idx))}
          </>
        )}
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create({
  flex1: { flex: 1 },
  panelDocked: {
    borderTopWidth: StyleSheet.hairlineWidth,
    maxHeight: 220,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  panelFloating: {
    position: 'absolute',
    right: 16,
    bottom: 74,
    width: 320,
    maxWidth: '92%',
    maxHeight: 340,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    zIndex: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scroll: { maxHeight: 250 },
  scrollContent: { paddingTop: 8, gap: 4 },
  sectionTitle: { paddingHorizontal: 4, paddingBottom: 2, fontWeight: '600' },
  sectionGap: { marginTop: 8 },
  infoStrip: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 6,
    gap: 2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
});
