import type { PlayerUiEvent, PlayerUiKey } from '../../../src/shared/player-ipc.ts';

/** Host keys accepted by `OpenVideoEngine.onHostKey` (`#420`). */
export type DesktopHostKey = Exclude<PlayerUiKey, 'close'>;

/** Handlers for desktop out-of-DOM mpv UI events (`player:ui`). */
export interface DesktopUiHandlers {
  toggleFullscreen(): void;
  onHostKey(key: DesktopHostKey): void;
  onClose(): void;
}

/** Maps any `PlayerUiKey` emitted by mpv into the renderer's `HostKey` union (`close` -> `back`). */
export function mapHostKey(key: PlayerUiKey): DesktopHostKey {
  switch (key) {
    case 'close':
      return 'back';
    case 'channel-up':
    case 'channel-down':
    case 'back':
    case 'fullscreen':
    case 'play-pause':
    case 'seek-back':
    case 'seek-forward':
    case 'seek-coarse-back':
    case 'seek-coarse-forward':
    case 'mute':
    case 'tracks':
    case 'prev-channel':
    case 'info':
    case 'channel-list':
      return key;
  }
}

/** Routes a `PlayerUiEvent` from main, separating explicit window/player close from `'back'`. */
export function routeDesktopUiEvent(event: PlayerUiEvent, handlers: DesktopUiHandlers): void {
  if (event.type === 'closed') {
    handlers.onClose();
    return;
  }
  if (event.type !== 'key') return;
  if (event.key === 'fullscreen') {
    handlers.toggleFullscreen();
    return;
  }
  if (event.key === 'close') {
    handlers.onClose();
    return;
  }
  handlers.onHostKey(mapHostKey(event.key));
}

/**
 * Exits `PlayerScreen` via `onHostKey('back')` when mpv closes (`q` or own-window close), dismissing
 * an open `TrackPickerModal` first if present so a closed mpv window never leaves the player stranded.
 */
export function dispatchDesktopClose(
  onHostKey: (key: DesktopHostKey) => void,
  isTrackPickerOpen: boolean,
): void {
  if (isTrackPickerOpen) onHostKey('back');
  onHostKey('back');
}
