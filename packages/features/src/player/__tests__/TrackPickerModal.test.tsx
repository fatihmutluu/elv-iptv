import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
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

function borderColorOf(testID: string): unknown {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style)?.borderColor;
}

describe('TrackPickerModal cursor highlight and auto-scroll', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('highlights the active cursor row and auto-scrolls on desktop as well as TV', async () => {
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

    expect(borderColorOf('player-audio-track-a:3')).toBe('#ffffff');
    expect(borderColorOf('player-audio-track-a:1')).toBe('#8d92a6');
    expect(borderColorOf('player-audio-track-a:2')).toBe('#2e2e3a');
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

    expect(borderColorOf('player-subtitle-track-s:3')).toBe('#ffffff');
    expect(borderColorOf('player-subtitle-off')).toBe('#8d92a6');
    expect(scrollSpy).toHaveBeenCalledWith({ y: 84, animated: false });
    await view.unmount();
  });

  it('omits the keyboard cursor ring and auto-scroll on touch form factors', async () => {
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

    expect(borderColorOf('player-audio-track-a:3')).toBe('#2e2e3a');
    expect(scrollSpy).not.toHaveBeenCalled();
    await view.unmount();
  });
});
