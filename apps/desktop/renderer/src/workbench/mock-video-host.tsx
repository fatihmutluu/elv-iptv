import type { VideoHost } from '@elv/features';
import type {
  AttemptToken,
  ChapterInfo,
  EngineEvent,
  LoadCommand,
  MediaTracks,
  PlayerEngine,
  StreamVideoInfo,
} from '@elv/playback';
import { MicroPill, TABULAR_NUMS_STYLE, useTheme } from '@elv/ui-kit';
import { type ReactElement, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

const WORKBENCH_VOD_DURATION_MS = 1_500_000;

const SAMPLE_MEDIA_INFO: StreamVideoInfo = {
  width: 1920,
  height: 1080,
  fps: 24,
  codec: 'hevc',
  hdr: 'hdr10',
  droppedFrames: 0,
};

const SAMPLE_VOD_CHAPTERS: readonly ChapterInfo[] = [
  { id: 'ch:0', title: 'Cold Open', startMs: 0, endMs: 500_000 },
  { id: 'ch:1', title: 'Act I', startMs: 500_000, endMs: 1_090_000 },
  { id: 'ch:2', title: 'Finale', startMs: 1_090_000, endMs: WORKBENCH_VOD_DURATION_MS },
];

const SAMPLE_TRACKS: MediaTracks = {
  audio: [
    { id: 'a1', language: 'en', label: 'English 5.1', codec: 'eac3', channels: 6, isDefault: true },
    { id: 'a2', language: 'tr', label: 'Turkish Stereo', codec: 'aac', channels: 2 },
  ],
  subtitles: [
    { id: 's1', language: 'tr', label: 'Turkish' },
    { id: 's2', language: 'en', label: 'English' },
  ],
  selectedAudioId: 'a1',
  selectedSubtitleId: null,
};

interface PreviewState {
  label: string;
  kind: 'live' | 'vod';
  state: string;
  positionMs: number;
  durationMs?: number;
}

function WorkbenchVideoSurface({
  subscribePreview,
}: {
  subscribePreview: (listener: (state: PreviewState) => void) => () => void;
}): ReactElement {
  const theme = useTheme();
  const [preview, setPreview] = useState<PreviewState>({
    label: 'Synthetic Cinema Feed',
    kind: 'live',
    state: 'opening',
    positionMs: 0,
  });

  useEffect(() => subscribePreview(setPreview), [subscribePreview]);

  const secs = Math.floor(preview.positionMs / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');

  return (
    <View style={[styles.surface, { backgroundColor: theme.colors.bgCanvas }]}>
      <View
        style={[
          styles.badgeBox,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
            padding: theme.spacing.lg,
          },
        ]}
      >
        <MicroPill
          label={preview.kind === 'live' ? 'WORKBENCH LIVE' : 'WORKBENCH VOD'}
          tone={preview.kind === 'live' ? 'live' : 'accent'}
        />
        <Text style={[theme.typography.h2, { color: theme.colors.textPrimary, marginTop: 10 }]}>
          {preview.label}
        </Text>
        <Text
          style={[
            theme.typography.caption,
            TABULAR_NUMS_STYLE,
            { color: theme.colors.textSecondary, marginTop: 6 },
          ]}
        >
          {`${preview.state.toUpperCase()} · ${mm}:${ss}`}
        </Text>
      </View>
    </View>
  );
}

/**
 * Interactive in-memory {@link VideoHost} for browser Workbench preview (`pnpm dev:ui`), letting
 * play/pause/seek and audio/subtitle pickers work live without native mpv/Media3/AetherEngine.
 */
export function createWorkbenchVideoHost(): VideoHost {
  return {
    open() {
      const listeners = new Set<(event: EngineEvent) => void>();
      const previewListeners = new Set<(state: PreviewState) => void>();
      const fullscreenListeners = new Set<(fullscreen: boolean) => void>();
      let attempt: AttemptToken = 0;
      let kind: 'live' | 'vod' = 'live';
      let label = 'Synthetic Cinema Feed';
      let positionMs = 0;
      let durationMs: number | undefined;
      let playing = false;
      let playbackRate = 1;
      let muted = false;
      let volume = 100;
      let fullscreen = false;
      let tracks: MediaTracks = SAMPLE_TRACKS;
      let timer: ReturnType<typeof setInterval> | null = null;

      const emit = (event: EngineEvent) => {
        for (const l of listeners) l(event);
      };

      const notifyPreview = (stateName: string) => {
        const suffix = muted ? ' · muted' : volume < 100 ? ` · ${Math.round(volume)}%` : '';
        const speedSuffix = playbackRate !== 1 ? ` · ${playbackRate}x` : '';
        const snapshot: PreviewState = {
          label,
          kind,
          state: `${stateName}${speedSuffix}${suffix}`,
          positionMs,
          ...(durationMs !== undefined ? { durationMs } : {}),
        };
        for (const l of previewListeners) l(snapshot);
      };

      const stopTimer = () => {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };

      const startTimer = () => {
        stopTimer();
        timer = setInterval(() => {
          if (!playing) return;
          positionMs += Math.round(1000 * playbackRate);
          if (durationMs !== undefined && positionMs > durationMs) positionMs = durationMs;
          emit({
            attempt,
            type: 'clock',
            anchor: {
              positionMs,
              atMs: performance.now(),
              rate: playbackRate,
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
          });
          notifyPreview('playing');
        }, 1000);
      };

      const engine: PlayerEngine = {
        capabilities: {
          mpegTsOverHttp: true,
          hls: true,
          liveSeek: false,
          softwareAudioFallback: true,
          recreate: true,
          audioTrackSelection: true,
          subtitleTrackSelection: true,
        },
        load(cmd: LoadCommand) {
          attempt = cmd.attempt;
          kind = cmd.kind;
          label = decodeURIComponent(cmd.url.split('/').pop() ?? 'Synthetic Stream');
          positionMs = cmd.startMs ?? 0;
          durationMs = cmd.kind === 'vod' ? WORKBENCH_VOD_DURATION_MS : undefined;
          playbackRate = 1;
          playing = true;
          tracks = { ...SAMPLE_TRACKS };
          emit({ attempt, type: 'state', state: 'playing' });
          emit({ attempt, type: 'firstFrame', atMs: performance.now() });
          emit({ attempt, type: 'mediaInfo', info: SAMPLE_MEDIA_INFO });
          emit({ attempt, type: 'tracks', tracks });
          if (cmd.kind === 'vod') {
            emit({ attempt, type: 'chapters', chapters: SAMPLE_VOD_CHAPTERS });
          }
          emit({
            attempt,
            type: 'clock',
            anchor: {
              positionMs,
              atMs: performance.now(),
              rate: playbackRate,
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
          });
          notifyPreview('playing');
          startTimer();
        },
        retry(nextAttempt) {
          attempt = nextAttempt;
          playing = true;
          emit({ attempt, type: 'state', state: 'playing' });
          emit({
            attempt,
            type: 'clock',
            anchor: {
              positionMs,
              atMs: performance.now(),
              rate: playbackRate,
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
          });
          notifyPreview('playing');
          startTimer();
        },
        play(nextAttempt) {
          attempt = nextAttempt;
          playing = true;
          emit({ attempt, type: 'state', state: 'playing' });
          emit({
            attempt,
            type: 'clock',
            anchor: {
              positionMs,
              atMs: performance.now(),
              rate: playbackRate,
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
          });
          notifyPreview('playing');
          startTimer();
        },
        pause(nextAttempt) {
          attempt = nextAttempt;
          playing = false;
          stopTimer();
          emit({ attempt, type: 'state', state: 'paused' });
          emit({
            attempt,
            type: 'clock',
            anchor: {
              positionMs,
              atMs: performance.now(),
              rate: 0,
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
          });
          notifyPreview('paused');
        },
        seek(nextAttempt, ms) {
          attempt = nextAttempt;
          positionMs = Math.max(0, ms);
          emit({
            attempt,
            type: 'clock',
            anchor: {
              positionMs,
              atMs: performance.now(),
              rate: playing ? playbackRate : 0,
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
          });
          notifyPreview(playing ? 'playing' : 'paused');
        },
        setSpeed(nextAttempt, rate) {
          attempt = nextAttempt;
          if (!Number.isFinite(rate) || rate <= 0) return;
          playbackRate = Math.min(4, Math.max(0.25, rate));
          emit({
            attempt,
            type: 'clock',
            anchor: {
              positionMs,
              atMs: performance.now(),
              rate: playing ? playbackRate : 0,
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
          });
        },
        selectAudioTrack(nextAttempt, id) {
          attempt = nextAttempt;
          tracks = { ...tracks, selectedAudioId: id };
          emit({ attempt, type: 'tracks', tracks });
        },
        selectSubtitleTrack(nextAttempt, id) {
          attempt = nextAttempt;
          tracks = { ...tracks, selectedSubtitleId: id };
          emit({ attempt, type: 'tracks', tracks });
        },
        stop(nextAttempt) {
          attempt = nextAttempt;
          playing = false;
          stopTimer();
          notifyPreview('idle');
        },
        recreate(nextAttempt) {
          attempt = nextAttempt;
          playing = false;
          stopTimer();
        },
        release() {
          playing = false;
          stopTimer();
          listeners.clear();
          previewListeners.clear();
          fullscreenListeners.clear();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };

      const subscribePreview = (listener: (state: PreviewState) => void) => {
        previewListeners.add(listener);
        listener({
          label,
          kind,
          state: playing ? 'playing' : 'idle',
          positionMs,
          ...(durationMs !== undefined ? { durationMs } : {}),
        });
        return () => previewListeners.delete(listener);
      };

      const opened = {
        engine,
        overlayMode: 'floating' as const,
        renderSurface: () => <WorkbenchVideoSurface subscribePreview={subscribePreview} />,
        toggleMute: () => {
          muted = !muted;
        },
        setVolume: (next: number) => {
          if (Number.isFinite(next)) volume = Math.min(100, Math.max(0, next));
          if (volume > 0) muted = false;
        },
        setResizeMode: (_mode: 'fit' | 'fill' | 'stretch') => undefined,
        setFilterSdh: (_enabled: boolean) => undefined,
        initialVolume: volume,
        toggleFullscreen: () => {
          fullscreen = !fullscreen;
          for (const listener of [...fullscreenListeners]) {
            try {
              listener(fullscreen);
            } catch {
              // isolate fullscreen subscribers
            }
          }
        },
        isFullscreen: () => fullscreen,
        onFullscreenChange: (listener: (next: boolean) => void) => {
          fullscreenListeners.add(listener);
          return () => {
            fullscreenListeners.delete(listener);
          };
        },
      };
      return opened;
    },
  };
}

const styles = StyleSheet.create({
  surface: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeBox: {
    borderWidth: 1,
    alignItems: 'center',
    minWidth: 280,
  },
});
