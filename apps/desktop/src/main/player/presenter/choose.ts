import type { PresenterKind } from '../../../shared/player-ipc.ts';

/** The Windows default presenter: zero-copy out-of-process in-canvas shared texture compositing (`#95`). */
export const WINDOWS_DEFAULT_PRESENTER: PresenterKind = 'canvas';

/** Parses an optional `ELV_DESKTOP_PRESENTER` environment override into a valid `PresenterKind`. */
export function parsePresenterOverride(raw: string | undefined): PresenterKind | undefined {
  const trimmed = raw?.trim();
  if (trimmed === 'canvas' || trimmed === 'child-window' || trimmed === 'own-window') {
    return trimmed;
  }
  return undefined;
}

/** Picks the presenter: an override wins; Windows uses its default; macOS and the rest use mpv's own window. */
export function choosePresenter(
  platform: NodeJS.Platform,
  override?: PresenterKind,
): PresenterKind {
  if (override) return override;
  return platform === 'win32' ? WINDOWS_DEFAULT_PRESENTER : 'own-window';
}
