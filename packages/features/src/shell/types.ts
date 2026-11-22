import type { IconName } from '@elv/ui-kit';
import type { ReactNode } from 'react';

/** One primary navigation destination rendered in the top bar (Landscape) or bottom tab bar (Portrait). */
export interface NavDestination<TId extends string = string> {
  readonly id: TId;
  readonly label: string;
  readonly icon: IconName;
  readonly testID?: string;
  readonly badge?: string;
}

/** One secondary utility action rendered on the right edge of the top navigation bar. */
export interface NavUtility<TId extends string = string> {
  readonly id: TId;
  readonly label: string;
  readonly icon: IconName;
  readonly active?: boolean;
  readonly showLabel?: boolean;
  readonly testID?: string;
  readonly onPress: () => void;
}

/** Props of {@link AdaptiveNavShell}. */
export interface AdaptiveNavShellProps<TId extends string = string> {
  readonly brandTitle: string;
  readonly showBrand?: boolean;
  readonly destinations: readonly NavDestination<TId>[];
  readonly utilities?: readonly NavUtility[];
  readonly activeId: string;
  readonly onSelectDestination: (id: TId) => void;
  readonly navFocused?: boolean;
  readonly onExitNavFocus?: () => void;
  /**
   * Handles TV `back` while top navigation is focused (`#425`).
   * Return `true` when consumed (e.g. returning to Home from a secondary tab), or `false` at root Home to allow OS exit.
   */
  readonly onBack?: () => boolean;
  readonly frosted?: boolean;
  /** When true, positions the top bar absolutely over full-bleed hero content (`zIndex: 35`). */
  readonly overlay?: boolean;
  readonly testID?: string;
  readonly children: ReactNode;
}
