import type { PresenterKind } from '../../../shared/player-ipc.ts';

/** The Windows presenter, set by the `--wid` go/no-go on the development PC (see `apps/desktop/AGENTS.md`). */
export const WINDOWS_DEFAULT_PRESENTER: PresenterKind = 'child-window';

/** Picks the presenter: an override wins; Windows uses its default; macOS and the rest use mpv's own window. */
export function choosePresenter(
  platform: NodeJS.Platform,
  override?: PresenterKind,
): PresenterKind {
  if (override) return override;
  return platform === 'win32' ? WINDOWS_DEFAULT_PRESENTER : 'own-window';
}
