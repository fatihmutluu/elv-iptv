import { EMPTY_TRACKS, type MediaTracks } from '@elv/playback';
import { act, renderHook } from '@testing-library/react-native';
import { PROGRESS_OSD_AUTO_HIDE_MS } from '../player-overlay-model';
import { usePlayerOverlayState } from '../usePlayerOverlayState';
import { createManualClock } from './player-test-harness';

const TRACKS: MediaTracks = {
  audio: [{ id: 'a:1', language: 'eng' }],
  subtitles: [{ id: 's:1', language: 'eng' }],
  selectedAudioId: 'a:1',
  selectedSubtitleId: null,
};

async function renderOverlay(overrides: Partial<Parameters<typeof usePlayerOverlayState>[0]> = {}) {
  const manual = createManualClock();
  const clockRef = { current: { now: manual.now } };
  const timersRef = {
    current: { setTimeout: manual.schedule, clearTimeout: manual.cancel },
  };
  const cancelScrub = jest.fn();

  const hook = await renderHook(
    (p: Partial<Parameters<typeof usePlayerOverlayState>[0]>) =>
      usePlayerOverlayState({
        formFactor: 'desktop',
        itemKey: 'ch:1',
        isVod: false,
        statusKind: 'playing',
        tracks: TRACKS,
        hasTracks: true,
        hasService: true,
        showRetry: false,
        hasSettings: true,
        hasChannelList: true,
        hasWindowModeMenu: true,
        hasNextEpisode: false,
        hasPreviousChannel: false,
        autoHideOsdMs: 3_500,
        isScrubbing: false,
        clockRef,
        timersRef,
        cancelScrub,
        ...overrides,
        ...p,
      }),
    { initialProps: {} },
  );

  return { manual, hook, cancelScrub };
}

describe('usePlayerOverlayState 3-tier OSD and supplement sheets (#391, #57, Wave R4)', () => {
  it('starts in controls or hidden tier, auto-hides progress at 2000ms and controls at 3500ms', async () => {
    const { manual, hook } = await renderOverlay({ initialOsdHidden: true, autoHideOsdMs: 3_500 });
    expect(hook.result.current.publicState.osdTier).toBe('hidden');
    expect(hook.result.current.publicState.osdHidden).toBe(true);

    await act(async () => {
      hook.result.current.showProgressOsd();
    });
    expect(hook.result.current.publicState.osdTier).toBe('progress');
    expect(hook.result.current.publicState.osdHidden).toBe(false);

    await act(async () => {
      manual.advance(PROGRESS_OSD_AUTO_HIDE_MS - 1);
    });
    expect(hook.result.current.publicState.osdTier).toBe('progress');

    await act(async () => {
      manual.advance(1);
    });
    expect(hook.result.current.publicState.osdTier).toBe('hidden');
    expect(hook.result.current.publicState.osdHidden).toBe(true);

    await act(async () => {
      hook.result.current.showControlsOsd();
    });
    expect(hook.result.current.publicState.osdTier).toBe('controls');
    await act(async () => {
      manual.advance(2_000);
    });
    expect(hook.result.current.publicState.osdTier).toBe('controls');
    await act(async () => {
      hook.result.current.showProgressOsd();
    });
    expect(hook.result.current.publicState.osdTier).toBe('controls');

    await act(async () => {
      manual.advance(3_499);
    });
    expect(hook.result.current.publicState.osdTier).toBe('controls');
    await act(async () => {
      manual.advance(1);
    });
    expect(hook.result.current.publicState.osdTier).toBe('hidden');

    await hook.unmount();
  });

  it('keeps settings, windowMode, and channelList mutually exclusive and pauses auto-hide', async () => {
    const { manual, hook } = await renderOverlay({ autoHideOsdMs: 3_500 });

    await act(async () => {
      hook.result.current.publicState.openWindowMode();
    });
    expect(hook.result.current.publicState.windowModeOpen).toBe(true);
    expect(hook.result.current.publicState.channelListOpen).toBe(false);
    expect(hook.result.current.publicState.settingsOpen).toBe(false);
    expect(hook.result.current.publicState.osdTier).toBe('controls');

    // Auto-hide is paused while Window Mode popover is open
    await act(async () => {
      manual.advance(10_000);
    });
    expect(hook.result.current.publicState.osdTier).toBe('controls');
    expect(hook.result.current.publicState.windowModeOpen).toBe(true);

    // Opening Channel List closes Window Mode mutually exclusively
    await act(async () => {
      hook.result.current.publicState.openChannelList();
    });
    expect(hook.result.current.publicState.channelListOpen).toBe(true);
    expect(hook.result.current.publicState.windowModeOpen).toBe(false);

    // Opening Settings (Subtitles view) closes Channel List
    await act(async () => {
      hook.result.current.publicState.openSettings('subtitles');
    });
    expect(hook.result.current.publicState.settingsOpen).toBe(true);
    expect(hook.result.current.publicState.settingsMenu.view).toBe('subtitles');
    expect(hook.result.current.publicState.channelListOpen).toBe(false);

    // toggleWindowMode opens and closes Window Mode cleanly and closes Settings
    await act(async () => {
      hook.result.current.publicState.toggleWindowMode();
    });
    expect(hook.result.current.publicState.windowModeOpen).toBe(true);
    expect(hook.result.current.publicState.settingsOpen).toBe(false);
    await act(async () => {
      hook.result.current.publicState.toggleWindowMode();
    });
    expect(hook.result.current.publicState.windowModeOpen).toBe(false);

    // toggleChannelList opens and closes Channel List cleanly
    await act(async () => {
      hook.result.current.publicState.toggleChannelList();
    });
    expect(hook.result.current.publicState.channelListOpen).toBe(true);
    await act(async () => {
      hook.result.current.publicState.toggleChannelList();
    });
    expect(hook.result.current.publicState.channelListOpen).toBe(false);

    await hook.unmount();
  });

  it('forces osdTier to hidden when locked on mobile and wakes to controls on desktop pointer hover', async () => {
    const mobile = await renderOverlay({
      formFactor: 'phone',
      tracks: EMPTY_TRACKS,
      hasTracks: false,
      hasWindowModeMenu: false,
      autoHideOsdMs: 3_500,
    });

    await act(async () => {
      mobile.hook.result.current.publicState.openSettings();
    });
    expect(mobile.hook.result.current.publicState.settingsOpen).toBe(true);

    await act(async () => {
      mobile.hook.result.current.publicState.lockControls();
    });
    expect(mobile.hook.result.current.publicState.locked).toBe(true);
    expect(mobile.hook.result.current.publicState.settingsOpen).toBe(false);
    expect(mobile.hook.result.current.publicState.osdTier).toBe('hidden');
    expect(mobile.hook.result.current.publicState.osdHidden).toBe(true);

    await act(async () => {
      mobile.hook.result.current.publicState.unlockControls();
    });
    expect(mobile.hook.result.current.publicState.locked).toBe(false);
    expect(mobile.hook.result.current.publicState.osdTier).toBe('controls');
    await mobile.hook.unmount();

    const desktop = await renderOverlay({ formFactor: 'desktop', initialOsdHidden: true });
    expect(desktop.hook.result.current.publicState.osdTier).toBe('hidden');
    await act(async () => {
      desktop.hook.result.current.publicState.handlePointerHover('mouse', { x: 100, y: 100 });
      desktop.hook.result.current.publicState.handlePointerHover('mouse', { x: 120, y: 100 });
    });
    expect(desktop.hook.result.current.publicState.osdTier).toBe('controls');
    await desktop.hook.unmount();
  });
});
