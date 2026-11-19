import { describe, expect, it, vi } from 'vitest';
import { dispatchDesktopClose, routeDesktopUiEvent } from './host-keys.ts';

describe('routeDesktopUiEvent & dispatchDesktopClose', () => {
  it('separates close/closed from back and routes fullscreen and channel zaps cleanly', () => {
    const toggleFullscreen = vi.fn();
    const onHostKey = vi.fn();
    const onClose = vi.fn();
    const handlers = { toggleFullscreen, onHostKey, onClose };

    routeDesktopUiEvent({ type: 'presenter', kind: 'child-window', coversArea: true }, handlers);
    expect(toggleFullscreen).not.toHaveBeenCalled();
    expect(onHostKey).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    routeDesktopUiEvent({ type: 'key', key: 'fullscreen' }, handlers);
    expect(toggleFullscreen).toHaveBeenCalledTimes(1);

    routeDesktopUiEvent({ type: 'key', key: 'channel-up' }, handlers);
    routeDesktopUiEvent({ type: 'key', key: 'channel-down' }, handlers);
    routeDesktopUiEvent({ type: 'key', key: 'back' }, handlers);
    expect(onHostKey.mock.calls).toEqual([['channel-up'], ['channel-down'], ['back']]);
    expect(onClose).not.toHaveBeenCalled();

    routeDesktopUiEvent({ type: 'key', key: 'close' }, handlers);
    routeDesktopUiEvent({ type: 'closed' }, handlers);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onHostKey).toHaveBeenCalledTimes(3);
  });

  it('dispatchDesktopClose sends back once normally, or twice when track picker modal is open', () => {
    const keys: string[] = [];
    dispatchDesktopClose((k) => keys.push(k), false);
    expect(keys).toEqual(['back']);

    keys.length = 0;
    dispatchDesktopClose((k) => keys.push(k), true);
    expect(keys).toEqual(['back', 'back']);
  });
});
