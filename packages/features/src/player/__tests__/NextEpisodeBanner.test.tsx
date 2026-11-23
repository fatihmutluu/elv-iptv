import { createAppI18n } from '@elv/i18n';
import {
  EMPTY_TRACKS,
  type PlaybackService,
  type PlaybackState,
  type PlaybackTimers,
} from '@elv/playback';
import { buildTheme, ThemeProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import type { PlayableEntry } from '../../ports/play-target';
import { NextEpisodeBanner } from '../NextEpisodeBanner';

const EP_2: PlayableEntry = {
  itemKey: 'x:src-1:episode:102',
  sourceId: 'src-1',
  title: 'Awakening',
  kind: 'vod',
  season: 1,
  episode: 2,
  subtitle: 'S1 E2 · Awakening',
};

const EP_3: PlayableEntry = {
  itemKey: 'x:src-1:episode:201',
  sourceId: 'src-1',
  title: 'New Horizon',
  kind: 'vod',
  season: 2,
  episode: 1,
  subtitle: 'S2 E1 · New Horizon',
};

function createFakeService(positionMs = 95_000, durationMs = 100_000): PlaybackService {
  const state: PlaybackState = {
    status: { kind: 'playing' },
    attempt: 1,
    tracks: EMPTY_TRACKS,
    staleEventsDropped: 0,
    surfaceRecreationToken: 0,
    anchor: { positionMs, atMs: 1_000, rate: 0, durationMs },
  };
  return {
    getState: () => state,
    subscribe: () => () => undefined,
  } as unknown as PlaybackService;
}

function createManualTimers() {
  let nextId = 1;
  const tasks = new Map<number, { fn: () => void; remainingMs: number }>();
  const timers: PlaybackTimers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      tasks.set(id, { fn, remainingMs: ms });
      return id;
    },
    clearTimeout(handle) {
      tasks.delete(handle as number);
    },
  };
  return {
    timers,
    pendingCount: () => tasks.size,
    advance(ms: number) {
      let remaining = ms;
      while (remaining > 0) {
        let minDelay = Number.POSITIVE_INFINITY;
        for (const task of tasks.values()) {
          if (task.remainingMs < minDelay) minDelay = task.remainingMs;
        }
        if (!Number.isFinite(minDelay) || minDelay > remaining) {
          for (const task of tasks.values()) task.remainingMs -= remaining;
          break;
        }
        remaining -= minDelay;
        const due: Array<[number, () => void]> = [];
        for (const [id, task] of tasks.entries()) {
          task.remainingMs -= minDelay;
          if (task.remainingMs <= 0) due.push([id, task.fn]);
        }
        for (const [id, fn] of due) {
          tasks.delete(id);
          fn();
        }
      }
    },
  };
}

function flatStyle(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style);
}

describe('NextEpisodeBanner Cinema Quietude v2 countdown (#392)', () => {
  it('counts down to 0, renders tabular countdown + 3px accent progress bar, and auto-plays once', async () => {
    const i18n = createAppI18n('en');
    const theme = buildTheme({ preset: 'obsidianCrimson' });
    const manual = createManualTimers();
    const onPlayNext = jest.fn();

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <NextEpisodeBanner
          nextEpisode={EP_2}
          statusKind="playing"
          dismissed={false}
          service={createFakeService()}
          clock={{ now: () => 1_000 }}
          isTv={false}
          i18n={i18n}
          autoPlayNextEpisode
          countdownSeconds={3}
          timers={manual.timers}
          onPlayNext={onPlayNext}
          onDismiss={jest.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('player-next-episode-banner')).toHaveTextContent(/Up next/);
    expect(screen.getByTestId('player-next-episode-countdown')).toHaveTextContent(
      'Next episode in 3s',
    );
    expect(flatStyle('player-next-episode-countdown')?.fontVariant).toEqual(['tabular-nums']);
    expect(flatStyle('player-next-episode-progress')?.height).toBe(3);
    expect(flatStyle('player-next-episode-progress-fill')?.backgroundColor).toBe(
      theme.colors.accent,
    );
    expect(flatStyle('player-next-episode-progress-fill')?.width).toBe('0%');

    await act(async () => {
      manual.advance(1_000);
    });
    expect(screen.getByTestId('player-next-episode-countdown')).toHaveTextContent(
      'Next episode in 2s',
    );
    expect(onPlayNext).not.toHaveBeenCalled();

    await act(async () => {
      manual.advance(1_000);
    });
    expect(screen.getByTestId('player-next-episode-countdown')).toHaveTextContent(
      'Next episode in 1s',
    );
    expect(onPlayNext).not.toHaveBeenCalled();

    await act(async () => {
      manual.advance(1_000);
    });
    expect(onPlayNext).toHaveBeenCalledTimes(1);
    expect(onPlayNext).toHaveBeenCalledWith(EP_2.itemKey);

    // Never double-fires if more time passes
    await act(async () => {
      manual.advance(5_000);
    });
    expect(onPlayNext).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('pauses countdown when tvFocused or statusKind is paused, and resumes cleanly', async () => {
    const i18n = createAppI18n('en');
    const manual = createManualTimers();
    const onPlayNext = jest.fn();
    const service = createFakeService();

    const view = await render(
      <ThemeProvider>
        <NextEpisodeBanner
          nextEpisode={EP_2}
          statusKind="playing"
          dismissed={false}
          service={service}
          clock={{ now: () => 1_000 }}
          isTv
          tvFocused
          i18n={i18n}
          autoPlayNextEpisode
          countdownSeconds={3}
          timers={manual.timers}
          onPlayNext={onPlayNext}
          onDismiss={jest.fn()}
        />
      </ThemeProvider>,
    );

    await act(async () => {
      manual.advance(5_000);
    });
    expect(onPlayNext).not.toHaveBeenCalled();
    expect(screen.getByTestId('player-next-episode-countdown')).toHaveTextContent(
      'Next episode in 3s',
    );

    // Paused status also pauses countdown even when unfocused
    await view.rerender(
      <ThemeProvider>
        <NextEpisodeBanner
          nextEpisode={EP_2}
          statusKind="paused"
          dismissed={false}
          service={service}
          clock={{ now: () => 1_000 }}
          isTv={false}
          tvFocused={false}
          i18n={i18n}
          autoPlayNextEpisode
          countdownSeconds={3}
          timers={manual.timers}
          onPlayNext={onPlayNext}
          onDismiss={jest.fn()}
        />
      </ThemeProvider>,
    );
    await act(async () => {
      manual.advance(5_000);
    });
    expect(onPlayNext).not.toHaveBeenCalled();

    // Resuming playing allows countdown to complete
    await view.rerender(
      <ThemeProvider>
        <NextEpisodeBanner
          nextEpisode={EP_2}
          statusKind="playing"
          dismissed={false}
          service={service}
          clock={{ now: () => 1_000 }}
          isTv={false}
          tvFocused={false}
          i18n={i18n}
          autoPlayNextEpisode
          countdownSeconds={3}
          timers={manual.timers}
          onPlayNext={onPlayNext}
          onDismiss={jest.fn()}
        />
      </ThemeProvider>,
    );
    await act(async () => {
      manual.advance(3_000);
    });
    expect(onPlayNext).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('respects autoPlayNextEpisode=false, stops on dismiss, and resets on episode change', async () => {
    const i18n = createAppI18n('en');
    const manual = createManualTimers();
    const onPlayNext = jest.fn();
    const onDismiss = jest.fn();
    const service = createFakeService();

    const view = await render(
      <ThemeProvider>
        <NextEpisodeBanner
          nextEpisode={EP_2}
          statusKind="ended"
          dismissed={false}
          service={service}
          clock={{ now: () => 1_000 }}
          isTv={false}
          i18n={i18n}
          autoPlayNextEpisode={false}
          countdownSeconds={2}
          timers={manual.timers}
          onPlayNext={onPlayNext}
          onDismiss={onDismiss}
        />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('player-next-episode-countdown')).toBeNull();
    expect(screen.queryByTestId('player-next-episode-progress')).toBeNull();
    await act(async () => {
      manual.advance(10_000);
    });
    expect(onPlayNext).not.toHaveBeenCalled();

    // Manual CTA still works
    await fireEvent.press(screen.getByTestId('player-next-episode'));
    expect(onPlayNext).toHaveBeenCalledWith(EP_2.itemKey);

    // Enable auto-play and switch to EP_3 -> countdown resets cleanly
    onPlayNext.mockClear();
    await view.rerender(
      <ThemeProvider>
        <NextEpisodeBanner
          nextEpisode={EP_3}
          statusKind="ended"
          dismissed={false}
          service={service}
          clock={{ now: () => 1_000 }}
          isTv={false}
          i18n={i18n}
          autoPlayNextEpisode
          countdownSeconds={3}
          reduceMotion
          timers={manual.timers}
          onPlayNext={onPlayNext}
          onDismiss={onDismiss}
        />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('player-next-episode-countdown')).toHaveTextContent(
      'Next episode in 3s',
    );
    await act(async () => {
      manual.advance(1_000);
    });
    expect(screen.getByTestId('player-next-episode-countdown')).toHaveTextContent(
      'Next episode in 2s',
    );

    // Dismissing cancels pending timer and never auto-fires
    await view.rerender(
      <ThemeProvider>
        <NextEpisodeBanner
          nextEpisode={EP_3}
          statusKind="ended"
          dismissed
          service={service}
          clock={{ now: () => 1_000 }}
          isTv={false}
          i18n={i18n}
          autoPlayNextEpisode
          countdownSeconds={3}
          timers={manual.timers}
          onPlayNext={onPlayNext}
          onDismiss={onDismiss}
        />
      </ThemeProvider>,
    );
    await act(async () => {
      manual.advance(5_000);
    });
    expect(onPlayNext).not.toHaveBeenCalled();
    expect(manual.pendingCount()).toBe(0);

    await view.unmount();
  });

  it('pauses countdown while pointer-hovered on web and resumes on pointer leave', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const i18n = createAppI18n('en');
    const manual = createManualTimers();
    const onPlayNext = jest.fn();

    try {
      const view = await render(
        <ThemeProvider>
          <NextEpisodeBanner
            nextEpisode={EP_2}
            statusKind="playing"
            dismissed={false}
            service={createFakeService()}
            clock={{ now: () => 1_000 }}
            isTv={false}
            i18n={i18n}
            autoPlayNextEpisode
            countdownSeconds={2}
            timers={manual.timers}
            onPlayNext={onPlayNext}
            onDismiss={jest.fn()}
          />
        </ThemeProvider>,
      );

      const banner = screen.getByTestId('player-next-episode-banner');
      await act(async () => {
        banner.props.onPointerEnter?.();
      });
      await act(async () => {
        manual.advance(5_000);
      });
      expect(onPlayNext).not.toHaveBeenCalled();

      await act(async () => {
        banner.props.onPointerLeave?.();
      });
      await act(async () => {
        manual.advance(2_000);
      });
      expect(onPlayNext).toHaveBeenCalledTimes(1);

      await view.unmount();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('suppresses auto-countdown while autoAdvanceDisabled (gapless armed) while keeping manual Play now active (#205)', async () => {
    const i18n = createAppI18n('en');
    const manual = createManualTimers();
    const onPlayNext = jest.fn();
    const service = createFakeService();

    const view = await render(
      <ThemeProvider>
        <NextEpisodeBanner
          nextEpisode={EP_2}
          statusKind="playing"
          dismissed={false}
          service={service}
          clock={{ now: () => 1_000 }}
          isTv={false}
          i18n={i18n}
          autoPlayNextEpisode
          autoAdvanceDisabled
          countdownSeconds={3}
          timers={manual.timers}
          onPlayNext={onPlayNext}
          onDismiss={jest.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('player-next-episode-banner')).toHaveTextContent(/Up next/);
    expect(screen.getByTestId('player-next-episode')).toBeTruthy();
    expect(screen.queryByTestId('player-next-episode-countdown')).toBeNull();
    expect(screen.queryByTestId('player-next-episode-progress')).toBeNull();

    // Must NOT auto-fire while gapless append-play is armed
    await act(async () => {
      manual.advance(10_000);
    });
    expect(onPlayNext).not.toHaveBeenCalled();

    // Manual "Play now" CTA still triggers immediate skip
    await fireEvent.press(screen.getByTestId('player-next-episode'));
    expect(onPlayNext).toHaveBeenCalledTimes(1);
    expect(onPlayNext).toHaveBeenCalledWith(EP_2.itemKey);

    // When disarmed on a new episode, auto-countdown resumes normally
    onPlayNext.mockClear();
    await view.rerender(
      <ThemeProvider>
        <NextEpisodeBanner
          nextEpisode={EP_3}
          statusKind="playing"
          dismissed={false}
          service={service}
          clock={{ now: () => 1_000 }}
          isTv={false}
          i18n={i18n}
          autoPlayNextEpisode
          autoAdvanceDisabled={false}
          countdownSeconds={2}
          timers={manual.timers}
          onPlayNext={onPlayNext}
          onDismiss={jest.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('player-next-episode-countdown')).toHaveTextContent(
      'Next episode in 2s',
    );
    await act(async () => {
      manual.advance(2_000);
    });
    expect(onPlayNext).toHaveBeenCalledTimes(1);
    expect(onPlayNext).toHaveBeenCalledWith(EP_3.itemKey);

    await view.unmount();
  });
});
