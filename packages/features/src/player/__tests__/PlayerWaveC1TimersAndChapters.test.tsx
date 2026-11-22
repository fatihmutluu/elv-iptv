import { ok } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import type { ChapterInfo } from '@elv/playback';
import { createFakePlayerEngine } from '@elv/playback/testing';
import { FormFactorProvider, I18nProvider, ThemeProvider, TvRemoteProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { View } from 'react-native';
import type { PlayTarget } from '../../ports/play-target';
import { PlayerScreen } from '../PlayerScreen';
import { createManualClock } from './player-test-harness';

const CHAPTERS: readonly ChapterInfo[] = [
  { id: 'c:0', title: 'Prologue', startMs: 0, endMs: 60_000 },
  { id: 'c:1', title: 'The Journey Begins', startMs: 60_000, endMs: 180_000 },
  { id: 'c:2', title: 'Finale', startMs: 180_000, endMs: 300_000 },
];

const VOD_TARGET: PlayTarget = {
  itemKey: 'x:src-1:vod:777',
  kind: 'vod',
  title: 'The Grand Horizon',
  subtitle: '2026',
  sourceId: 'src-1',
};

describe('Wave C1 #118 — Sleep Timer, Chapter Markers & Still-Watching Prompt', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('configures Sleep Timer presets and Stop vs Pause action in Settings and executes on expiry', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const onExit = jest.fn();

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: async (k) =>
                    ok({ url: `http://sim.example.test/${k}.mp4`, headers: {} }),
                }}
                videoHost={{
                  open: () => ({ engine, overlayMode: 'floating', renderSurface: () => <View /> }),
                }}
                target={VOD_TARGET}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={onExit}
              />
            </I18nProvider>
          </FormFactorProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));
    await act(async () => manual.advance(350));

    // Open Settings -> Sleep Timer -> switch action to Pause -> pick 15 min
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    await fireEvent.press(screen.getByTestId('player-settings-row-sleep-timer'));
    expect(screen.getByTestId('player-settings-sleep-15')).toBeTruthy();
    expect(screen.getByTestId('player-settings-sleep-360')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('player-settings-sleep-action'));
    await fireEvent.press(screen.getByTestId('player-settings-sleep-15'));

    // Advance 15 minutes -> Pause action pauses playback without exiting
    await act(async () => {
      manual.advance(15 * 60_000 + 100);
    });
    expect(engine.commands.some((c) => c.name === 'pause')).toBe(true);
    expect(onExit).not.toHaveBeenCalled();

    // Switch back to Stop action and pick 15 min -> expiry stops and calls onExit
    await fireEvent.press(screen.getByTestId('player-settings-sleep-action'));
    await fireEvent.press(screen.getByTestId('player-settings-sleep-15'));
    await act(async () => {
      manual.advance(15 * 60_000 + 100);
    });
    expect(engine.commands.some((c) => c.name === 'stop')).toBe(true);
    expect(onExit).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('renders chapter dots on VodProgressBar, jumps prev/next chapter with 3s restart threshold, and opens Chapters sub-view', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: async (k) =>
                    ok({ url: `http://sim.example.test/${k}.mp4`, headers: {} }),
                }}
                videoHost={{
                  open: () => ({ engine, overlayMode: 'floating', renderSurface: () => <View /> }),
                }}
                target={VOD_TARGET}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={jest.fn()}
              />
            </I18nProvider>
          </FormFactorProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));
    const att = engine.commands.find((c) => c.name === 'load')?.attempt ?? 1;
    await act(async () => {
      manual.advance(350);
      engine.emit({
        attempt: att,
        type: 'clock',
        anchor: { positionMs: 70_000, atMs: manual.now(), rate: 0, durationMs: 300_000 },
      });
      engine.emit({ attempt: att, type: 'chapters', chapters: CHAPTERS });
    });

    // Chapter dots rendered on scrubber rail (excluding startMs === 0)
    expect(screen.getByTestId('player-chapter-dot-c:1')).toBeTruthy();
    expect(screen.getByTestId('player-chapter-dot-c:2')).toBeTruthy();

    // At 70s (> 3s into chapter c:1 starting at 60s): Prev chapter restarts chapter c:1 (60_000ms)
    await fireEvent.press(screen.getByTestId('player-prev-chapter'));
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(60_000);

    // Next chapter from 60s jumps to Finale (180_000ms)
    await fireEvent.press(screen.getByTestId('player-next-chapter'));
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(180_000);

    // Chapters sub-view inside Settings lists all chapters and seeks on press
    await fireEvent.press(screen.getByTestId('player-settings-button'));
    await fireEvent.press(screen.getByTestId('player-settings-row-chapters'));
    expect(screen.getByTestId('player-settings-chapter-c:0')).toHaveTextContent(/Prologue/);
    expect(screen.getByTestId('player-settings-chapter-c:1')).toHaveTextContent(
      /The Journey Begins/,
    );
    await fireEvent.press(screen.getByTestId('player-settings-chapter-c:0'));
    expect(engine.commands.filter((c) => c.name === 'seek').at(-1)?.positionMs).toBe(0);

    await view.unmount();
  });

  it('triggers Idle Still-Watching prompt after continuous playback without user input and stops + exits if countdown reaches 0', async () => {
    const manual = createManualClock();
    const engine = createFakePlayerEngine({
      now: manual.now,
      schedule: manual.schedule,
      cancel: manual.cancel,
    });
    const onExit = jest.fn();

    const view = await render(
      <ThemeProvider preset="obsidianCrimson">
        <TvRemoteProvider>
          <FormFactorProvider value="desktop">
            <I18nProvider i18n={createAppI18n('en')}>
              <PlayerScreen
                catalog={{
                  resolveStream: async (k) =>
                    ok({ url: `http://sim.example.test/${k}.mp4`, headers: {} }),
                }}
                videoHost={{
                  open: () => ({ engine, overlayMode: 'floating', renderSurface: () => <View /> }),
                }}
                target={VOD_TARGET}
                stillWatchingTimeoutMin={60}
                clock={{ now: manual.now }}
                timers={{ setTimeout: manual.schedule, clearTimeout: manual.cancel }}
                onExit={onExit}
              />
            </I18nProvider>
          </FormFactorProvider>
        </TvRemoteProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(engine.commands.some((c) => c.name === 'load')).toBe(true));
    await act(async () => manual.advance(350));

    expect(screen.queryByTestId('player-still-watching-prompt')).toBeNull();

    // Advance 60 minutes of uninterrupted active playback -> Still Watching prompt appears
    await act(async () => {
      manual.advance(60 * 60_000 + 100);
    });
    expect(screen.getByTestId('player-still-watching-prompt')).toBeTruthy();

    // Pressing "Keep watching" dismisses prompt and resets countdown cleanly
    await fireEvent.press(screen.getByTestId('player-still-watching-continue'));
    expect(screen.queryByTestId('player-still-watching-prompt')).toBeNull();
    expect(onExit).not.toHaveBeenCalled();

    // Advance another 60 minutes -> prompt returns -> let 60s countdown expire -> stops + exits
    await act(async () => {
      manual.advance(60 * 60_000 + 100);
    });
    expect(screen.getByTestId('player-still-watching-prompt')).toBeTruthy();

    await act(async () => {
      manual.advance(60_000 + 100);
    });
    expect(engine.commands.some((c) => c.name === 'stop')).toBe(true);
    expect(onExit).toHaveBeenCalledTimes(1);

    await view.unmount();
  });
});
