import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { buildTheme, THEME_PRESETS, ThemeProvider } from '@elv/ui-kit';
import { render, screen } from '@testing-library/react-native';
import { ScrollView, StyleSheet } from 'react-native';
import { TrackPickerModal } from '../TrackPickerModal';

const LONG_TRACKS: MediaTracks = {
  audio: [
    { id: 'a:1', language: 'tur', label: 'Turkish' },
    { id: 'a:2', language: 'eng', label: 'English' },
    { id: 'a:3', language: 'deu', label: 'German' },
    { id: 'a:4', language: 'fra', label: 'French' },
  ],
  subtitles: [
    { id: 's:1', language: 'tur' },
    { id: 's:2', language: 'eng' },
    { id: 's:3', language: 'deu' },
  ],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

const DEFAULT_THEME = buildTheme({ preset: 'obsidianCrimson' });
const HIGH_CONTRAST_THEME = buildTheme({ preset: 'highContrast' });

function flatStyleOf(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style);
}

describe('TrackPickerModal cursor highlight, auto-scroll, and live theming', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('highlights the active cursor row with live theme tokens and auto-scrolls on desktop as well as TV', async () => {
    const scrollSpy = jest
      .spyOn(ScrollView.prototype as unknown as { scrollTo: () => void }, 'scrollTo')
      .mockImplementation(() => undefined);
    scrollSpy.mockClear();
    const i18n = createAppI18n('en');

    const view = await render(
      <TrackPickerModal
        tracks={LONG_TRACKS}
        cursor={{ column: 'audio', index: 2 }}
        isTv={false}
        formFactor="desktop"
        i18n={i18n}
        onSelectAudio={jest.fn()}
        onSelectSubtitle={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(flatStyleOf('player-tracks-panel')?.backgroundColor).toBe(DEFAULT_THEME.colors.glassBg);
    expect(flatStyleOf('player-audio-track-a:3')?.borderColor).toBe(
      THEME_PRESETS.obsidianCrimson.focusRingColor,
    );
    expect(flatStyleOf('player-audio-track-a:3')?.borderWidth).toBe(DEFAULT_THEME.focus.ringWidth);
    expect(flatStyleOf('player-audio-track-a:1')?.borderColor).toBe(
      THEME_PRESETS.obsidianCrimson.accent,
    );
    expect(flatStyleOf('player-audio-track-a:2')?.borderColor).toBe(
      DEFAULT_THEME.colors.surfaceBorder,
    );
    expect(scrollSpy).toHaveBeenCalledWith({ y: 42, animated: false });

    scrollSpy.mockClear();
    await view.rerender(
      <TrackPickerModal
        tracks={LONG_TRACKS}
        cursor={{ column: 'subtitles', index: 3 }}
        isTv={false}
        formFactor="desktop"
        i18n={i18n}
        onSelectAudio={jest.fn()}
        onSelectSubtitle={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    expect(flatStyleOf('player-subtitle-track-s:3')?.borderColor).toBe(
      THEME_PRESETS.obsidianCrimson.focusRingColor,
    );
    expect(flatStyleOf('player-subtitle-off')?.borderColor).toBe(
      THEME_PRESETS.obsidianCrimson.accent,
    );
    expect(scrollSpy).toHaveBeenCalledWith({ y: 84, animated: false });
    await view.unmount();
  });

  it('omits the keyboard cursor ring and auto-scroll on touch form factors and enforces >= 40px rows', async () => {
    const scrollSpy = jest
      .spyOn(ScrollView.prototype as unknown as { scrollTo: () => void }, 'scrollTo')
      .mockImplementation(() => undefined);
    scrollSpy.mockClear();
    const i18n = createAppI18n('en');

    const view = await render(
      <TrackPickerModal
        tracks={LONG_TRACKS}
        cursor={{ column: 'audio', index: 2 }}
        isTv={false}
        formFactor="phone"
        i18n={i18n}
        onSelectAudio={jest.fn()}
        onSelectSubtitle={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    const rowStyle = flatStyleOf('player-audio-track-a:3');
    expect(rowStyle?.borderColor).toBe(DEFAULT_THEME.colors.surfaceBorder);
    expect(Number(rowStyle?.minHeight ?? 0)).toBeGreaterThanOrEqual(40);
    expect(scrollSpy).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('renders WCAG AAA High Contrast tokens (#000000 canvas glass & #FACC15 focus ring)', async () => {
    const i18n = createAppI18n('en');

    const view = await render(
      <ThemeProvider preset="highContrast">
        <TrackPickerModal
          tracks={LONG_TRACKS}
          cursor={{ column: 'audio', index: 2 }}
          isTv
          formFactor="tv"
          i18n={i18n}
          onSelectAudio={jest.fn()}
          onSelectSubtitle={jest.fn()}
          onClose={jest.fn()}
        />
      </ThemeProvider>,
    );

    expect(THEME_PRESETS.highContrast.bgCanvas).toBe('#000000');
    expect(flatStyleOf('player-tracks-panel')?.backgroundColor).toBe(
      HIGH_CONTRAST_THEME.colors.glassBg,
    );
    expect(flatStyleOf('player-audio-track-a:3')?.borderColor).toBe('#FACC15');
    expect(flatStyleOf('player-audio-track-a:1')?.borderColor).toBe('#FACC15');
    await view.unmount();
  });
});
