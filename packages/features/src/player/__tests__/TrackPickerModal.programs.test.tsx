import { createAppI18n } from '@elv/i18n';
import type { MediaTracks } from '@elv/playback';
import { ThemeProvider, ViewportProvider } from '@elv/ui-kit';
import { fireEvent, render } from '@testing-library/react-native';
import { TrackPickerModal } from '../TrackPickerModal';

const i18n = createAppI18n('en');

function renderPicker(
  tracks: MediaTracks,
  onSelectProgram = jest.fn(),
  cursor: { column: 'program' | 'audio' | 'subtitles'; index: number } = {
    column: 'audio',
    index: 0,
  },
) {
  return render(
    <ThemeProvider>
      <ViewportProvider>
        <TrackPickerModal
          tracks={tracks}
          cursor={cursor}
          isTv
          formFactor="tv"
          i18n={i18n}
          onSelectProgram={onSelectProgram}
          onSelectAudio={jest.fn()}
          onSelectSubtitle={jest.fn()}
          onClose={jest.fn()}
        />
      </ViewportProvider>
    </ThemeProvider>,
  );
}

describe('TrackPickerModal multi-program MPEG-TS (#304)', () => {
  it('hides the Program column when stream has <= 1 program', async () => {
    const singleProgram: MediaTracks = {
      programs: [{ id: 'p:1', label: 'Main', programNumber: 1 }],
      selectedProgramId: 'p:1',
      audio: [{ id: 'a:1', language: 'eng', programId: 'p:1' }],
      subtitles: [{ id: 's:1', language: 'eng', programId: 'p:1' }],
      selectedAudioId: 'a:1',
      selectedSubtitleId: null,
    };
    const view = await renderPicker(singleProgram);
    expect(view.queryByTestId('player-program-column')).toBeNull();
    expect(view.getByTestId('player-audio-column')).toBeTruthy();
    expect(view.getByTestId('player-subtitle-column')).toBeTruthy();
  });

  it('shows the Program column, filters tracks by selectedProgramId, and invokes onSelectProgram', async () => {
    const onSelectProgram = jest.fn();
    const multiProgram: MediaTracks = {
      programs: [
        { id: 'p:101', label: 'News HD', serviceName: 'News HD', programNumber: 101 },
        { id: 'p:102', label: 'Sports HD', serviceName: 'Sports HD', programNumber: 102 },
      ],
      selectedProgramId: 'p:101',
      audio: [
        { id: 'a:101', language: 'eng', programId: 'p:101' },
        { id: 'a:102', language: 'tur', programId: 'p:102' },
      ],
      subtitles: [
        { id: 's:101', language: 'eng', programId: 'p:101' },
        { id: 's:102', language: 'tur', programId: 'p:102' },
      ],
      selectedAudioId: 'a:101',
      selectedSubtitleId: 's:101',
    };

    const view = await renderPicker(multiProgram, onSelectProgram, { column: 'program', index: 0 });
    expect(view.getByTestId('player-program-column')).toBeTruthy();
    expect(view.getByTestId('player-program-track-p:101')).toBeTruthy();
    expect(view.getByTestId('player-program-track-p:102')).toBeTruthy();

    expect(view.getByTestId('player-audio-track-a:101')).toBeTruthy();
    expect(view.queryByTestId('player-audio-track-a:102')).toBeNull();
    expect(view.getByTestId('player-subtitle-track-s:101')).toBeTruthy();
    expect(view.queryByTestId('player-subtitle-track-s:102')).toBeNull();

    await fireEvent.press(view.getByTestId('player-program-track-p:102'));
    expect(onSelectProgram).toHaveBeenCalledWith('p:102');
  });
});
