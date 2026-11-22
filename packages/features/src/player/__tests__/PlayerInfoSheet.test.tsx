import type { NowNextEntry } from '@elv/data';
import { createAppI18n } from '@elv/i18n';
import { EMPTY_TRACKS, type MediaTracks, type StreamVideoInfo } from '@elv/playback';
import { I18nProvider, ThemeProvider } from '@elv/ui-kit';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { buildStreamQualityBadges, PlayerInfoSheet } from '../PlayerInfoSheet';

const SAMPLE_TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'eng', label: 'English', codec: 'eac3', channels: 6 },
    { id: 'a:2', language: 'tur', label: 'Turkish', codec: 'aac', channels: 2 },
  ],
  subtitles: [{ id: 's:1', language: 'eng', label: 'English' }],
  selectedAudioId: 'a:1',
  selectedSubtitleId: 's:1',
};

const SAMPLE_VIDEO_INFO: StreamVideoInfo = {
  width: 3840,
  height: 2160,
  fps: 50,
  codec: 'hevc',
  hdr: 'hdr10',
};

function makeLocalTime(hours: number, minutes: number): number {
  const d = new Date(2026, 10, 22, hours, minutes, 0, 0);
  return d.getTime();
}

const SAMPLE_NOW_NEXT: NowNextEntry = {
  channelKey: 'm:src:ch:1',
  now: {
    channelKey: 'm:src:ch:1',
    sourceId: 'src',
    guideId: 'ch-1',
    start: makeLocalTime(20, 0),
    stop: makeLocalTime(21, 0),
    title: 'Evening News',
    subTitle: 'Prime Edition',
    description: 'Comprehensive evening news coverage from around the world.',
    episodeNum: null,
    icon: null,
    genre: null,
    flags: 0,
  },
  next: {
    channelKey: 'm:src:ch:1',
    sourceId: 'src',
    guideId: 'ch-1',
    start: makeLocalTime(21, 0),
    stop: makeLocalTime(22, 30),
    title: 'Night Documentary',
    subTitle: null,
    description: null,
    episodeNum: null,
    icon: null,
    genre: null,
    flags: 0,
  },
};

function flatStyle(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style);
}

describe('PlayerInfoSheet', () => {
  it('returns null when hidden', async () => {
    const i18n = createAppI18n('en');
    const view = await render(
      <ThemeProvider>
        <I18nProvider i18n={i18n}>
          <PlayerInfoSheet
            visible={false}
            title="Channel One"
            isVod={false}
            tracks={EMPTY_TRACKS}
            formFactor="desktop"
            isTv={false}
            i18n={i18n}
            onClose={jest.fn()}
          />
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('player-info-panel')).toBeNull();
    await view.unmount();
  });

  it('renders live Now/Next programme window, progress, synopsis, and real stream badges', async () => {
    const i18n = createAppI18n('en');
    const onClose = jest.fn();
    const view = await render(
      <ThemeProvider preset="highContrast">
        <I18nProvider i18n={i18n}>
          <PlayerInfoSheet
            visible
            title="Channel One"
            isVod={false}
            nowNext={SAMPLE_NOW_NEXT}
            videoInfo={SAMPLE_VIDEO_INFO}
            tracks={SAMPLE_TRACKS}
            formFactor="desktop"
            isTv={false}
            i18n={i18n}
            nowMs={makeLocalTime(20, 30)}
            onClose={onClose}
          />
        </I18nProvider>
      </ThemeProvider>,
    );

    // Desktop docks in normal flow (HWND-safe, no AdaptiveSheet overlay)
    expect(screen.getByTestId('player-info-desktop-dialog')).toBeTruthy();
    expect(screen.queryByTestId('player-info-sheet')).toBeNull();
    expect(flatStyle('player-info-desktop-dialog')?.position).toBeUndefined();

    const panel = screen.getByTestId('player-info-panel');
    expect(panel).toHaveTextContent(/Programme info/);
    expect(panel).toHaveTextContent(/On now/);
    expect(panel).toHaveTextContent(/Evening News/);
    expect(panel).toHaveTextContent(/20:00–21:00/);
    expect(panel).toHaveTextContent(/Comprehensive evening news coverage/);
    expect(panel).toHaveTextContent(/Up next/);
    expect(panel).toHaveTextContent(/Night Documentary/);
    expect(panel).toHaveTextContent(/21:00–22:30/);
    expect(flatStyle('player-info-progress-fill')?.width).toBe('50%');
    expect(flatStyle('player-info-now-window')?.fontVariant).toEqual(['tabular-nums']);

    // Real decoded videoInfo + active audio/subtitle badges
    const quality = screen.getByTestId('player-info-quality');
    expect(quality).toHaveTextContent(/Stream quality/);
    expect(quality).toHaveTextContent(/4K/);
    expect(quality).toHaveTextContent(/3840×2160/);
    expect(quality).toHaveTextContent(/50 fps/);
    expect(quality).toHaveTextContent(/HEVC/);
    expect(quality).toHaveTextContent(/HDR10/);
    expect(quality).toHaveTextContent(/EAC3 5\.1/);
    expect(quality).toHaveTextContent(/English/);

    await fireEvent.press(screen.getByTestId('player-info-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    const preventDefault = jest.fn();
    screen.getByTestId('player-info-desktop-dialog').props.onKeyDown?.({
      key: 'Escape',
      preventDefault,
    });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it('shows noProgrammeInfo on live when EPG is absent, wraps in AdaptiveSheet on phone, and never fakes quality badges', async () => {
    const i18n = createAppI18n('en');
    const view = await render(
      <ThemeProvider>
        <I18nProvider i18n={i18n}>
          <PlayerInfoSheet
            visible
            title="News 24"
            isVod={false}
            nowNext={null}
            tracks={EMPTY_TRACKS}
            formFactor="phone"
            isTv={false}
            i18n={i18n}
            onClose={jest.fn()}
          />
        </I18nProvider>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('player-info-sheet')).toBeTruthy();
    expect(screen.getByTestId('player-info-panel')).toHaveTextContent(/News 24/);
    expect(screen.getByTestId('player-info-panel')).toHaveTextContent(
      /No programme information available/,
    );
    expect(screen.queryByTestId('player-info-quality')).toBeNull();

    // Pure badge builder produces empty array when no real telemetry exists
    expect(buildStreamQualityBadges(undefined, EMPTY_TRACKS, i18n)).toEqual([]);

    await view.unmount();
  });

  it('renders VOD title and subtitle cleanly without live EPG fallback copy', async () => {
    const i18n = createAppI18n('en');
    const view = await render(
      <ThemeProvider>
        <I18nProvider i18n={i18n}>
          <PlayerInfoSheet
            visible
            title="Starlight"
            subtitle="S1 E2 · Awakening"
            isVod
            videoInfo={{ width: 1920, height: 1080, fps: 23.976, codec: 'h264', hdr: 'dv' }}
            tracks={EMPTY_TRACKS}
            formFactor="tv"
            isTv
            i18n={i18n}
            onClose={jest.fn()}
          />
        </I18nProvider>
      </ThemeProvider>,
    );

    const panel = screen.getByTestId('player-info-panel');
    expect(panel).toHaveTextContent(/Starlight/);
    expect(panel).toHaveTextContent(/S1 E2 · Awakening/);
    expect(panel).not.toHaveTextContent(/No programme information available/);
    expect(screen.getByTestId('player-info-quality')).toHaveTextContent(/1080p/);
    expect(screen.getByTestId('player-info-quality')).toHaveTextContent(/23\.98 fps/);
    expect(screen.getByTestId('player-info-quality')).toHaveTextContent(/H264/);
    expect(screen.getByTestId('player-info-quality')).toHaveTextContent(/DV/);

    await view.unmount();
  });
});
