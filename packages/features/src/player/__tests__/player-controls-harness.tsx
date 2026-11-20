import type {
  ClockAnchor,
  MediaTracks,
  PlaybackService,
  PlaybackStatus,
  PlaybackTimers,
} from '@elv/playback';
import { EMPTY_TRACKS } from '@elv/playback';
import { type FormFactor, RemoteKeysProvider } from '@elv/ui-kit';
import { renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import { usePlayerControls } from '../usePlayerControls';
import { createFakeAndroidKeys } from './player-test-harness';

export const KEY = {
  back: 4,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  select: 23,
  menu: 82,
  playPause: 85,
  play: 126,
  pause: 127,
} as const;

const NOW_MS = 1_000;

export const MULTI_TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'tur' },
    { id: 'a:2', language: 'eng' },
    { id: 'a:3', language: 'deu' },
  ],
  subtitles: [
    { id: 's:1', language: 'tur' },
    { id: 's:2', language: 'eng' },
  ],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

/** Props driving the hook under test; every field is optional with VOD-on-TV defaults. */
export interface ControlsProps {
  status?: PlaybackStatus;
  tracks?: MediaTracks;
  showRetry?: boolean;
  hasService?: boolean;
  itemKey?: string;
  kind?: 'vod' | 'live';
  formFactor?: FormFactor;
}

export function pausedAnchor(positionMs: number, durationMs?: number): ClockAnchor {
  return { positionMs, atMs: NOW_MS, rate: 0, ...(durationMs !== undefined ? { durationMs } : {}) };
}

export function createFakeService(status: PlaybackStatus, anchor?: ClockAnchor) {
  let state: { status: PlaybackStatus; anchor: ClockAnchor | undefined } = { status, anchor };
  const fake = {
    getState: () => state,
    play: jest.fn(),
    pause: jest.fn(),
    retry: jest.fn(),
    seek: jest.fn((positionMs: number) => {
      state = { ...state, anchor: { ...(state.anchor ?? pausedAnchor(0)), positionMs } };
    }),
    selectAudioTrack: jest.fn(),
    selectSubtitleTrack: jest.fn(),
  };
  return {
    fake,
    service: fake as unknown as PlaybackService,
    setState(next: Partial<typeof state>) {
      state = { ...state, ...next };
    },
  };
}

/** Mocks an Android TV runtime with jest fake timers (the key interpreter ticks on `setInterval`). */
export function mockAndroidTvRuntime(): void {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
}

export async function renderControls(
  svc: ReturnType<typeof createFakeService> | null,
  initial: ControlsProps = {},
) {
  const keys = createFakeAndroidKeys();
  const timers: PlaybackTimers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const refs = {
    serviceRef: { current: svc?.service ?? null },
    clockRef: { current: { now: () => NOW_MS } },
    timersRef: { current: timers },
    onExitRef: { current: jest.fn() },
    zapByRef: { current: jest.fn() },
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RemoteKeysProvider android={keys.source}>{children}</RemoteKeysProvider>
  );
  const hook = await renderHook(
    (p: ControlsProps) => {
      const tracks = p.tracks ?? EMPTY_TRACKS;
      const target: PlayTarget = {
        itemKey: p.itemKey ?? 'x:src-1:vod:1',
        sourceId: 'src-1',
        title: 'Synthetic item',
        kind: p.kind ?? 'vod',
      };
      return usePlayerControls({
        formFactor: p.formFactor ?? 'tv',
        activeTarget: target,
        status: p.status ?? { kind: 'playing' },
        tracks,
        hasTracks: tracks.audio.length > 0 || tracks.subtitles.length > 0,
        showRetry: p.showRetry ?? false,
        hasService: p.hasService ?? svc !== null,
        ...refs,
      });
    },
    { initialProps: initial, wrapper },
  );
  return { keys, refs, hook };
}
