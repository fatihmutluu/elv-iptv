import type { PresenterKind } from '../../../shared/player-ipc.ts';

/** The Windows default presenter: zero-copy out-of-process in-canvas shared texture compositing (`#95`). */
export const WINDOWS_DEFAULT_PRESENTER: PresenterKind = 'canvas';

/** The macOS default presenter: zero-copy out-of-process in-canvas IOSurface compositing (`#95`). */
export const DARWIN_DEFAULT_PRESENTER: PresenterKind = 'canvas';

/** Parses an optional `ELV_DESKTOP_PRESENTER` environment override into a valid `PresenterKind`. */
export function parsePresenterOverride(raw: string | undefined): PresenterKind | undefined {
  const trimmed = raw?.trim();
  if (trimmed === 'canvas' || trimmed === 'child-window' || trimmed === 'own-window') {
    return trimmed;
  }
  return undefined;
}

/** Picks the presenter: an override wins; Windows and macOS use their defaults; other platforms use mpv's own window. */
export function choosePresenter(
  platform: NodeJS.Platform,
  override?: PresenterKind,
): PresenterKind {
  if (override) return override;
  if (platform === 'win32') return WINDOWS_DEFAULT_PRESENTER;
  if (platform === 'darwin') return DARWIN_DEFAULT_PRESENTER;
  return 'own-window';
}
