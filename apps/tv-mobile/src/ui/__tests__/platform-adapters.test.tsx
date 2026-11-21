import { createDeadHostRegistry } from '@elv/ui-kit';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { AppStateStatus } from 'react-native';
import { attachAppStateDeadHostReset, createMobileTvUiAdapters } from '../platform-adapters';

describe('createMobileTvUiAdapters (#311, #202)', () => {
  it('renders an Image with clamped maxDecodePx, resizeMethod="resize", fadeDuration={0}, and progressiveRenderingEnabled', async () => {
    const adapters = createMobileTvUiAdapters();
    if (!adapters.renderImage) throw new Error('expected renderImage adapter');

    const onLoad = jest.fn();
    const onError = jest.fn();
    await render(
      adapters.renderImage({
        uri: 'https://cdn.example/logo.png',
        resizeMode: 'contain',
        maxDecodePx: 120,
        accessibilityLabel: 'News HD',
        onLoad,
        onError,
      }),
    );

    const img = screen.getByLabelText('News HD');
    expect(img.props.source).toEqual({
      uri: 'https://cdn.example/logo.png',
      width: 120,
      height: 120,
    });
    expect(img.props.resizeMode).toBe('contain');
    expect(img.props.resizeMethod).toBe('resize');
    expect(img.props.fadeDuration).toBe(0);
    expect(img.props.progressiveRenderingEnabled).toBe(true);

    await fireEvent(img, 'load');
    expect(onLoad).toHaveBeenCalledTimes(1);

    await fireEvent(img, 'error', {
      nativeEvent: { error: 'java.net.UnknownHostException: Unable to resolve host' },
    });
    expect(onError).toHaveBeenCalledWith({
      message: 'java.net.UnknownHostException: Unable to resolve host',
    });
  });

  it('clamps sub-32 maxDecodePx to 32px and handles empty native error events safely', async () => {
    const adapters = createMobileTvUiAdapters();
    if (!adapters.renderImage) throw new Error('expected renderImage adapter');
    const onError = jest.fn();

    await render(
      adapters.renderImage({
        uri: 'https://cdn.example/tiny.png',
        resizeMode: 'cover',
        maxDecodePx: 12,
        accessibilityLabel: 'Tiny Icon',
        onError,
      }),
    );

    const img = screen.getByLabelText('Tiny Icon');
    expect(img.props.source).toEqual({
      uri: 'https://cdn.example/tiny.png',
      width: 32,
      height: 32,
    });

    await fireEvent(img, 'error');
    expect(onError).toHaveBeenCalledWith(undefined);
  });
});

describe('attachAppStateDeadHostReset (#202)', () => {
  it('resets DeadHostRegistry only when returning from background to active', () => {
    const registry = createDeadHostRegistry();
    registry.recordFailure('https://offline.example/logo.png', { message: 'ENOTFOUND' });
    expect(registry.isDead('https://offline.example/other.png')).toBe(true);

    let listener: ((state: AppStateStatus) => void) | undefined;
    const remove = jest.fn();
    const fakeAppState = {
      currentState: 'active' as AppStateStatus,
      addEventListener: jest.fn((_type: 'change', cb: (state: AppStateStatus) => void) => {
        listener = cb;
        return { remove };
      }),
    };

    const detach = attachAppStateDeadHostReset(fakeAppState, registry);

    // inactive -> active should NOT reset
    listener?.('inactive');
    listener?.('active');
    expect(registry.isDead('https://offline.example/other.png')).toBe(true);

    // background -> active MUST reset so reconnected networks recover dead hosts
    listener?.('background');
    expect(registry.isDead('https://offline.example/other.png')).toBe(true);
    listener?.('active');
    expect(registry.isDead('https://offline.example/other.png')).toBe(false);

    // iOS/tvOS background -> inactive -> active MUST also reset
    registry.recordFailure('https://tvos-offline.example/logo.png', { message: 'ENOTFOUND' });
    expect(registry.isDead('https://tvos-offline.example/other.png')).toBe(true);
    listener?.('background');
    listener?.('inactive');
    expect(registry.isDead('https://tvos-offline.example/other.png')).toBe(true);
    listener?.('active');
    expect(registry.isDead('https://tvos-offline.example/other.png')).toBe(false);

    detach();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
