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
  readonly frosted?: boolean;
  readonly testID?: string;
  readonly children: ReactNode;
}
