import { type ReactElement, useEffect } from 'react';
import { Platform, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme';

const SKELETON_STYLE_ID = 'elv-ui-kit-skeleton-pulse';
const SKELETON_KEYFRAMES_CSS =
  '@keyframes elv-skeleton-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }';

interface WebStyleElementLike {
  id: string;
  textContent: string | null;
}

interface WebDocumentLike {
  getElementById(id: string): unknown;
  createElement(tag: 'style'): WebStyleElementLike;
  head?: { appendChild(node: WebStyleElementLike): void } | null;
}

function ensureSkeletonKeyframes(): void {
  if (Platform.OS !== 'web') return;
  const doc = (globalThis as { document?: WebDocumentLike }).document;
  if (!doc?.head || doc.getElementById(SKELETON_STYLE_ID)) return;
  const styleEl = doc.createElement('style');
  styleEl.id = SKELETON_STYLE_ID;
  styleEl.textContent = SKELETON_KEYFRAMES_CSS;
  doc.head.appendChild(styleEl);
}

/** Props of {@link SkeletonBox}. */
export interface SkeletonBoxProps {
  width?: number | `${number}%`;
  height?: number;
  aspectRatio?: number;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Zero-CLS tonal Cinema Quietude loading block derived strictly from `theme.colors.bgCard` and
 * `theme.colors.bgElevated`. Renders a hairline `surfaceBorder` in `highContrast` AAA mode, a
 * gentle CSS pulse on web only when `!theme.reduceMotion`, and a static tonal block on native or
 * under reduced motion.
 */
export function SkeletonBox({
  width,
  height,
  aspectRatio,
  borderRadius,
  style,
  testID,
}: SkeletonBoxProps): ReactElement {
  const theme = useTheme();
  const animateWeb = Platform.OS === 'web' && !theme.reduceMotion;

  useEffect(() => {
    if (animateWeb) ensureSkeletonKeyframes();
  }, [animateWeb]);

  const webTonalStyle: ViewStyle | undefined =
    Platform.OS === 'web'
      ? ({
          backgroundImage: `linear-gradient(135deg, ${theme.colors.bgCard} 0%, ${theme.colors.bgElevated} 100%)`,
          ...(animateWeb
            ? {
                animationName: 'elv-skeleton-pulse',
                animationDuration: '1.6s',
                animationTimingFunction: 'ease-in-out',
                animationIterationCount: 'infinite',
              }
            : {}),
        } as unknown as ViewStyle)
      : undefined;

  return (
    <View
      testID={testID}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          backgroundColor: theme.colors.bgCard,
          borderRadius: borderRadius ?? theme.radius.card,
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          ...(aspectRatio !== undefined ? { aspectRatio } : {}),
          ...(theme.highContrast
            ? {
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.surfaceBorder,
              }
            : {}),
        },
        webTonalStyle,
        style,
      ]}
    />
  );
}
