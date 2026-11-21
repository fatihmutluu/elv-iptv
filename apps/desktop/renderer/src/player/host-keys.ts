import type { PlayerUiEvent } from '../../../src/shared/player-ipc.ts';

/** Host keys accepted by `OpenVideoEngine.onHostKey`. */
export type DesktopHostKey = 'channel-up' | 'channel-down' | 'back' | 'fullscreen';

/** Handlers for desktop out-of-DOM mpv UI events (`player:ui`). */
export interface DesktopUiHandlers {
  toggleFullscreen(): void;
  onHostKey(key: DesktopHostKey): void;
  onClose(): void;
}

/** Routes a `PlayerUiEvent` from main, separating explicit window/player close from `'back'`. */
export function routeDesktopUiEvent(event: PlayerUiEvent, handlers: DesktopUiHandlers): void {
  if (event.type === 'closed') {
    handlers.onClose();
    return;
  }
  if (event.type !== 'key') return;
  switch (event.key) {
    case 'fullscreen':
      handlers.toggleFullscreen();
      return;
    case 'close':
      handlers.onClose();
      return;
    case 'back':
    case 'channel-up':
    case 'channel-down':
      handlers.onHostKey(event.key);
  }
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
