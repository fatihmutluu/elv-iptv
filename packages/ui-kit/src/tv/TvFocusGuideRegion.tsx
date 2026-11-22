import type { ComponentType, ReactElement, ReactNode } from 'react';
import { Platform, type StyleProp, View, type ViewStyle } from 'react-native';

/** Props of {@link TvFocusGuideRegion}. */
export interface TvFocusGuideRegionProps {
  /**
   * Controls whether this focus-guide region actively participates in TV focus (`#130`, `#281`).
   * Because `react-native-tvos` maps `TVFocusGuideView`'s `enabled={false}` to `{ display: 'none' }`
   * (hiding visible container subtrees), this component keeps native `enabled={true}` and gates
   * `autoFocus`, `focusable`, and `trapFocus*` instead.
   */
  readonly enabled?: boolean;
  /** Enables automatic focus restoration to the last focused child in this sibling region (`#281`). */
  readonly autoFocus?: boolean;
  readonly trapFocusLeft?: boolean;
  readonly trapFocusRight?: boolean;
  readonly trapFocusUp?: boolean;
  readonly trapFocusDown?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
  readonly children: ReactNode;
}

type NativeFocusGuideComponent = ComponentType<Record<string, unknown>>;

function isReactComponent(value: unknown): value is NativeFocusGuideComponent {
  return (
    typeof value === 'function' ||
    (typeof value === 'object' && value !== null && '$$typeof' in value)
  );
}

function getNativeFocusGuide(): NativeFocusGuideComponent | null {
  if (!Platform.isTV || (Platform.OS as string) === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require('react-native') as { TVFocusGuideView?: unknown };
    return isReactComponent(rn.TVFocusGuideView) ? rn.TVFocusGuideView : null;
  } catch {
    return null;
  }
}

/**
 * Non-nested sibling TV focus-guide region (`#281`, `#130`).
 * Renders React Native TV's `TVFocusGuideView` keeping native `enabled={true}` so container children stay
 * visible while gating `autoFocus`, `focusable`, and `trapFocus*` via `enabled`; falls back cleanly to a
 * plain `View` on web, phone, tablet, and desktop.
 */
export function TvFocusGuideRegion({
  enabled = true,
  autoFocus = true,
  trapFocusLeft,
  trapFocusRight,
  trapFocusUp,
  trapFocusDown,
  style,
  testID,
  children,
}: TvFocusGuideRegionProps): ReactElement {
  const NativeGuide = getNativeFocusGuide();
  if (NativeGuide) {
    return (
      <NativeGuide
        testID={testID}
        enabled={true}
        autoFocus={enabled && autoFocus}
        focusable={enabled ? undefined : false}
        {...(enabled && trapFocusLeft !== undefined ? { trapFocusLeft } : {})}
        {...(enabled && trapFocusRight !== undefined ? { trapFocusRight } : {})}
        {...(enabled && trapFocusUp !== undefined ? { trapFocusUp } : {})}
        {...(enabled && trapFocusDown !== undefined ? { trapFocusDown } : {})}
        style={style}
      >
        {children}
      </NativeGuide>
    );
  }
  return (
    <View testID={testID} style={style}>
      {children}
    </View>
  );
}
