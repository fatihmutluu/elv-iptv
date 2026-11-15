import type { AppI18n } from '@elv/i18n';
import {
  type PlaybackClock,
  type PlaybackService,
  type PlaybackStatus,
  positionAt,
} from '@elv/playback';
import { type ReactElement, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { type DescribedPlaybackFailure, describePlaybackFailure } from './errors';

function formatPosition(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(clamped % 60).padStart(2, '0');
  const minutes = Math.floor(clamped / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

/** Formats localized OSD status text from `PlaybackStatus`. */
export function formatStatusLine(status: PlaybackStatus, i18n: AppI18n): string {
  switch (status.kind) {
    case 'idle':
      return i18n.t('player.status.idle');
    case 'tuning':
      return i18n.t('player.status.tuning');
    case 'playing':
      return i18n.t('player.status.playing');
    case 'paused':
      return i18n.t('player.status.paused');
    case 'ended':
      return i18n.t('player.status.ended');
    case 'recovering':
      return i18n.t('player.status.recovering', { rung: status.rung });
    case 'limited':
      return i18n.t('player.status.limited');
    case 'failed':
      return i18n.t(describePlaybackFailure(status.error).messageId);
  }
}

function OsdClock({
  service,
  clock,
}: {
  service: PlaybackService | null;
  clock: PlaybackClock;
}): ReactElement {
  const [text, setText] = useState('--:--');

  useEffect(() => {
    if (service === null) {
      setText('--:--');
      return;
    }
    let frame = 0;
    const tick = (): void => {
      const { anchor } = service.getState();
      const next = anchor === undefined ? '--:--' : formatPosition(positionAt(anchor, clock.now()));
      setText((prev) => (prev === next ? prev : next));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [clock, service]);

  return (
    <Text testID="osd-clock" style={playerStyles.clock}>
      {text}
    </Text>
  );
}

function OsdButton({
  testID,
  label,
  onPress,
  isTv,
  tvFocused = false,
}: {
  testID: string;
  label: string;
  onPress: () => void;
  isTv: boolean;
  tvFocused?: boolean;
}): ReactElement {
  return (
    <Pressable
      testID={testID}
      {...(isTv ? { focusable: false } : {})}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: tvFocused }}
      onPress={onPress}
      style={[playerStyles.button, tvFocused ? playerStyles.buttonTvFocused : null]}
    >
      <Text style={playerStyles.buttonText}>{label}</Text>
    </Pressable>
  );
}

/** Always-mounted plain on-screen display over the video surface. */
export function PlayerOsd({
  title,
  statusLine,
  failure,
  canZap,
  showRetry,
  isTv,
  i18n,
  service,
  clock,
  onExit,
  onPrev,
  onNext,
  onRetry,
}: {
  title: string;
  statusLine: string;
  failure: DescribedPlaybackFailure | null;
  canZap: boolean;
  showRetry: boolean;
  isTv: boolean;
  i18n: AppI18n;
  service: PlaybackService | null;
  clock: PlaybackClock;
  onExit: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRetry: () => void;
}): ReactElement {
  return (
    <View testID="player-osd" style={[playerStyles.osd, isTv ? playerStyles.osdTv : null]}>
      <View style={playerStyles.osdTopRow}>
        <View style={playerStyles.osdTitles}>
          <Text testID="osd-title" style={[playerStyles.title, isTv ? playerStyles.titleTv : null]}>
            {title}
          </Text>
          <Text testID="osd-status" style={playerStyles.status}>
            {statusLine}
          </Text>
        </View>
        <OsdClock service={service} clock={clock} />
      </View>

      {failure !== null ? (
        <View style={playerStyles.errorBox}>
          <Text testID="osd-error-hint" style={playerStyles.hintText}>
            {i18n.t(failure.hintId)}
          </Text>
        </View>
      ) : null}

      <View style={playerStyles.controlsRow}>
        <OsdButton
          testID="player-back"
          label={i18n.t('player.back')}
          onPress={onExit}
          isTv={isTv}
        />
        {canZap ? (
          <>
            <OsdButton
              testID="player-prev"
              label={i18n.t('player.prevChannel')}
              onPress={onPrev}
              isTv={isTv}
            />
            <OsdButton
              testID="player-next"
              label={i18n.t('player.nextChannel')}
              onPress={onNext}
              isTv={isTv}
            />
          </>
        ) : null}
        {showRetry ? (
          <OsdButton
            testID="player-retry"
            label={i18n.t('player.retry')}
            onPress={onRetry}
            isTv={isTv}
            tvFocused={isTv}
          />
        ) : null}
      </View>
    </View>
  );
}

export const playerStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000', justifyContent: 'flex-end' },
  tvFocusAnchor: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  surfaceLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  osd: {
    backgroundColor: 'rgba(10, 10, 14, 0.86)',
    borderTopColor: '#2a2a34',
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  osdTv: { paddingHorizontal: 48, paddingVertical: 24 },
  osdTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
  },
  osdTitles: { flex: 1, gap: 4 },
  title: { color: '#f4f4f6', fontSize: 18, fontWeight: '700' },
  titleTv: { fontSize: 24 },
  status: { color: '#b4b8c4', fontSize: 14 },
  clock: { color: '#f4f4f6', fontSize: 16, fontWeight: '600' },
  errorBox: {
    backgroundColor: '#241416',
    borderColor: '#6e2c32',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  hintText: { color: '#e6c0c0', fontSize: 13 },
  controlsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  button: {
    backgroundColor: '#1e1e26',
    borderColor: '#3a3a46',
    borderWidth: 2,
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  buttonTvFocused: { borderColor: '#ffffff' },
  buttonText: { color: '#f4f4f6', fontSize: 14, fontWeight: '600' },
});
