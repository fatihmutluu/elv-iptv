import { createAppI18n } from '@elv/i18n';
import { ThemeProvider } from '@elv/ui-kit';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import {
  classifyDoubleTapSide,
  classifyTouchGesture,
  computeScrubDeltaMs,
  EDGE_EXCLUSION_PX,
  isInEdgeExclusionZone,
  PlayerTouchGestures,
} from '../PlayerTouchGestures';

function flatStyle(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style);
}

describe('PlayerTouchGestures pure helpers', () => {
  it('detects 24px edge exclusion zone on all 4 edges', () => {
    expect(EDGE_EXCLUSION_PX).toBe(24);
    expect(isInEdgeExclusionZone(10, 200, 800, 400)).toBe(true);
    expect(isInEdgeExclusionZone(790, 200, 800, 400)).toBe(true);
    expect(isInEdgeExclusionZone(400, 10, 800, 400)).toBe(true);
    expect(isInEdgeExclusionZone(400, 390, 800, 400)).toBe(true);
    expect(isInEdgeExclusionZone(24, 24, 800, 400)).toBe(false);
    expect(isInEdgeExclusionZone(400, 200, 800, 400)).toBe(false);
  });

  it('classifies left vertical=brightness, right vertical=volume, VOD horizontal=scrub', () => {
    expect(
      classifyTouchGesture({
        startX: 10,
        startY: 200,
        dx: 0,
        dy: -40,
        width: 800,
        height: 400,
        isVod: true,
      }),
    ).toBe('edge-excluded');

    expect(
      classifyTouchGesture({
        startX: 200,
        startY: 200,
        dx: 4,
        dy: -25,
        width: 800,
        height: 400,
        isVod: true,
      }),
    ).toBe('brightness');

    expect(
      classifyTouchGesture({
        startX: 600,
        startY: 200,
        dx: 4,
        dy: 25,
        width: 800,
        height: 400,
        isVod: false,
      }),
    ).toBe('volume');

    expect(
      classifyTouchGesture({
        startX: 400,
        startY: 200,
        dx: 30,
        dy: 5,
        width: 800,
        height: 400,
        isVod: true,
      }),
    ).toBe('scrub');

    // Horizontal swipe on Live does not scrub
    expect(
      classifyTouchGesture({
        startX: 400,
        startY: 200,
        dx: 30,
        dy: 5,
        width: 800,
        height: 400,
        isVod: false,
      }),
    ).toBe('none');
  });

  it('computes VOD scrub delta (+-90s per screen width) and double-tap zones', () => {
    expect(computeScrubDeltaMs(400, 800)).toBe(45_000);
    expect(computeScrubDeltaMs(-400, 800)).toBe(-45_000);
    expect(computeScrubDeltaMs(400, 800, 80_000, 100_000)).toBe(20_000);
    expect(computeScrubDeltaMs(-400, 800, 10_000, 100_000)).toBe(-10_000);

    expect(classifyDoubleTapSide(100, 800)).toBe(-1);
    expect(classifyDoubleTapSide(400, 800)).toBe(0);
    expect(classifyDoubleTapSide(700, 800)).toBe(1);
  });
});

describe('PlayerTouchGestures interactions', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function renderGestures(
    overrides: Partial<Parameters<typeof PlayerTouchGestures>[0]> = {},
  ) {
    const i18n = createAppI18n('en');
    const handlers = {
      onTouchActivity: jest.fn(),
      onSingleTap: jest.fn(),
      onDoubleTapSeek: jest.fn(),
      onVolumeChange: jest.fn(),
      onBrightnessChange: jest.fn(),
      onScrubPreview: jest.fn(),
      onScrubCommit: jest.fn(),
      onHoldSpeedStart: jest.fn(),
      onHoldSpeedEnd: jest.fn(),
    };
    const view = await render(
      <ThemeProvider>
        <PlayerTouchGestures
          isVod
          volume={50}
          brightness={0.5}
          positionMs={60_000}
          durationMs={300_000}
          i18n={i18n}
          {...handlers}
          {...overrides}
        />
      </ThemeProvider>,
    );
    const layer = screen.getByTestId('player-touch-gestures');
    await fireEvent(layer, 'layout', { nativeEvent: { layout: { width: 800, height: 400 } } });
    return { view, layer, ...handlers };
  }

  it('renders non-interactive dim overlay proportional to brightness and ignores edge touches', async () => {
    const { view, layer, onSingleTap, onBrightnessChange } = await renderGestures({
      brightness: 0.5,
    });

    const dim = screen.getByTestId('player-brightness-dim-overlay');
    expect(dim.props.pointerEvents).toBe('none');
    expect(flatStyle('player-brightness-dim-overlay')?.opacity).toBeCloseTo(0.35, 2);

    // Touch starting inside 24px left edge is ignored
    await act(async () => {
      layer.props.onResponderGrant?.({ nativeEvent: { locationX: 10, locationY: 200 } });
      layer.props.onResponderMove?.({ nativeEvent: { locationX: 10, locationY: 120 } });
      layer.props.onResponderRelease?.({ nativeEvent: { locationX: 10, locationY: 120 } });
    });
    expect(onBrightnessChange).not.toHaveBeenCalled();
    expect(onSingleTap).not.toHaveBeenCalled();

    await view.unmount();
  });

  it('handles left-half brightness swipe, right-half volume swipe, and VOD horizontal scrub', async () => {
    const { view, layer, onBrightnessChange, onVolumeChange, onScrubPreview, onScrubCommit } =
      await renderGestures();

    // Left vertical swipe up -> increases brightness
    await act(async () => {
      layer.props.onResponderGrant?.({ nativeEvent: { locationX: 150, locationY: 250 } });
      layer.props.onResponderMove?.({ nativeEvent: { locationX: 150, locationY: 190 } });
    });
    expect(onBrightnessChange).toHaveBeenCalled();
    expect(onBrightnessChange.mock.calls[0]?.[0]).toBeGreaterThan(0.5);
    expect(screen.getByTestId('player-touch-feedback-pill')).toHaveTextContent(/Brightness/);

    await act(async () => {
      layer.props.onResponderRelease?.({ nativeEvent: { locationX: 150, locationY: 190 } });
    });
    expect(screen.queryByTestId('player-touch-feedback-pill')).toBeNull();

    // Left vertical swipe far down clamps brightness cleanly to MIN_BRIGHTNESS (15%)
    await act(async () => {
      layer.props.onResponderGrant?.({ nativeEvent: { locationX: 150, locationY: 50 } });
      layer.props.onResponderMove?.({ nativeEvent: { locationX: 150, locationY: 380 } });
    });
    expect(onBrightnessChange).toHaveBeenLastCalledWith(0.15);
    expect(screen.getByTestId('player-touch-feedback-pill')).toHaveTextContent('Brightness 15%');
    await act(async () => {
      layer.props.onResponderRelease?.({ nativeEvent: { locationX: 150, locationY: 380 } });
    });

    // Right vertical swipe up -> increases volume
    await act(async () => {
      layer.props.onResponderGrant?.({ nativeEvent: { locationX: 650, locationY: 250 } });
      layer.props.onResponderMove?.({ nativeEvent: { locationX: 650, locationY: 190 } });
    });
    expect(onVolumeChange).toHaveBeenCalled();
    expect(onVolumeChange.mock.calls[0]?.[0]).toBeGreaterThan(50);
    expect(screen.getByTestId('player-touch-feedback-pill')).toHaveTextContent(/Volume/);

    await act(async () => {
      layer.props.onResponderRelease?.({ nativeEvent: { locationX: 650, locationY: 190 } });
    });

    // Horizontal VOD scrub -> previews + commits delta
    await act(async () => {
      layer.props.onResponderGrant?.({ nativeEvent: { locationX: 300, locationY: 200 } });
      layer.props.onResponderMove?.({ nativeEvent: { locationX: 433, locationY: 202 } });
    });
    expect(onScrubPreview).toHaveBeenCalled();
    expect(screen.getByTestId('player-touch-feedback-pill')).toHaveTextContent(/\+0:15/);

    await act(async () => {
      layer.props.onResponderRelease?.({ nativeEvent: { locationX: 433, locationY: 202 } });
    });
    expect(onScrubPreview).toHaveBeenLastCalledWith(undefined);
    expect(onScrubCommit).toHaveBeenCalledWith(expect.any(Number));
    expect(onScrubCommit.mock.calls[0]?.[0]).toBeGreaterThan(10_000);

    await view.unmount();
  });

  it('handles double-tap +-10s seek, single tap, and 500ms hold-to-2x speed', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const { view, layer, onSingleTap, onDoubleTapSeek, onHoldSpeedStart, onHoldSpeedEnd } =
      await renderGestures();

    // Double-tap left 40% -> -10_000ms (cancels single tap)
    await act(async () => {
      layer.props.onResponderGrant?.({ nativeEvent: { locationX: 120, locationY: 200 } });
      layer.props.onResponderRelease?.({ nativeEvent: { locationX: 120, locationY: 200 } });
      jest.advanceTimersByTime(150);
      layer.props.onResponderGrant?.({ nativeEvent: { locationX: 125, locationY: 200 } });
      layer.props.onResponderRelease?.({ nativeEvent: { locationX: 125, locationY: 200 } });
      jest.advanceTimersByTime(300);
    });
    expect(onDoubleTapSeek).toHaveBeenCalledWith(-10_000);
    expect(onSingleTap).not.toHaveBeenCalled();

    // Double-tap right 40% -> +10_000ms
    await act(async () => {
      layer.props.onResponderGrant?.({ nativeEvent: { locationX: 700, locationY: 200 } });
      layer.props.onResponderRelease?.({ nativeEvent: { locationX: 700, locationY: 200 } });
      jest.advanceTimersByTime(120);
      layer.props.onResponderGrant?.({ nativeEvent: { locationX: 702, locationY: 200 } });
      layer.props.onResponderRelease?.({ nativeEvent: { locationX: 702, locationY: 200 } });
      jest.advanceTimersByTime(300);
    });
    expect(onDoubleTapSeek).toHaveBeenLastCalledWith(10_000);
    expect(onSingleTap).not.toHaveBeenCalled();

    // Single tap in center -> fires immediately
    await act(async () => {
      layer.props.onResponderGrant?.({ nativeEvent: { locationX: 400, locationY: 200 } });
      layer.props.onResponderRelease?.({ nativeEvent: { locationX: 400, locationY: 200 } });
    });
    expect(onSingleTap).toHaveBeenCalledTimes(1);

    // 500ms stationary long-press -> hold 2x speed, release ends it without single tap
    await act(async () => {
      layer.props.onResponderGrant?.({ nativeEvent: { locationX: 400, locationY: 200 } });
      jest.advanceTimersByTime(500);
    });
    expect(onHoldSpeedStart).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('player-touch-hold-speed-pill')).toHaveTextContent(/2× speed/);

    await act(async () => {
      layer.props.onResponderRelease?.({ nativeEvent: { locationX: 400, locationY: 200 } });
    });
    expect(onHoldSpeedEnd).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('player-touch-hold-speed-pill')).toBeNull();
    expect(onSingleTap).toHaveBeenCalledTimes(1);

    // Single tap in left zone fires onSingleTap after the 280ms double-tap window
    await act(async () => {
      layer.props.onResponderGrant?.({ nativeEvent: { locationX: 120, locationY: 200 } });
      layer.props.onResponderRelease?.({ nativeEvent: { locationX: 120, locationY: 200 } });
    });
    expect(onSingleTap).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(280);
    });
    expect(onSingleTap).toHaveBeenCalledTimes(2);

    // Responder terminate while holding 2x ends hold speed cleanly
    await act(async () => {
      layer.props.onResponderGrant?.({ nativeEvent: { locationX: 400, locationY: 200 } });
      jest.advanceTimersByTime(500);
    });
    expect(onHoldSpeedStart).toHaveBeenCalledTimes(2);
    await act(async () => {
      layer.props.onResponderTerminate?.();
    });
    expect(onHoldSpeedEnd).toHaveBeenCalledTimes(2);

    await view.unmount();
  });
});
