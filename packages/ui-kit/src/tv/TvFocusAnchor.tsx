import type { ReactElement } from 'react';
import { View } from 'react-native';

/** Props of {@link TvFocusAnchor}. */
export interface TvFocusAnchorProps {
  /** Whether the anchor requests initial TV focus on mount. Defaults to `true`. */
  hasTVPreferredFocus?: boolean;
  /** Test identifier for querying the anchor in tests. Defaults to `'tv-focus-anchor'`. */
  testID?: string;
}

const anchorStyle = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: 1,
  height: 1,
  backgroundColor: 'transparent',
} as const;

/**
 * Transparent 1×1 focusable anchor for empty or loading TV screens so tvOS and Android TV retain an active focus
 * target and Menu/Back presses never fall through to the system home screen (#186).
 */
export function TvFocusAnchor({
  hasTVPreferredFocus = true,
  testID = 'tv-focus-anchor',
}: TvFocusAnchorProps): ReactElement {
  return (
    <View
      testID={testID}
      focusable
      hasTVPreferredFocus={hasTVPreferredFocus}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no"
      pointerEvents="none"
      style={anchorStyle}
    />
  );
}
