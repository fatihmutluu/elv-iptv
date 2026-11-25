import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { Platform, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { Theme } from './tokens';
import { webBackdropBlur, webShadow, webTransition } from './web-styles';

/** Maximum width in pixels of the floating tooltip bubble. */
export const TOOLTIP_MAX_WIDTH_PX = 240;

/** Active floating tooltip entry rendered by {@link TooltipHostProvider}. */
interface TooltipOverlayEntry {
  readonly id: string;
  readonly content: string;
  readonly description: string;
  readonly coords: { readonly left: number; readonly top: number } | null;
  readonly testID?: string | undefined;
}

/** Root overlay host controller for {@link Tooltip}. */
export interface TooltipHostController {
  showTooltip(entry: TooltipOverlayEntry): void;
  hideTooltip(id: string): void;
}

const TooltipHostContext = createContext<TooltipHostController | null>(null);

/** Reads the root tooltip overlay host provided by {@link ThemeProvider}, or `null` outside one. */
export function useTooltipHost(): TooltipHostController | null {
  return useContext(TooltipHostContext);
}

/** Shared Cinema Quietude v2 floating tooltip bubble used by both root host and inline fallback. */
export function TooltipBubble({
  theme,
  content,
  description,
  positionStyle,
  testID,
}: {
  readonly theme: Theme;
  readonly content: string;
  readonly description: string;
  readonly positionStyle: ViewStyle;
  readonly testID?: string | undefined;
}): ReactElement {
  const fontFamilyStyle =
    theme.typography.title.fontFamily !== undefined
      ? { fontFamily: theme.typography.title.fontFamily }
      : undefined;

  return (
    <View
      pointerEvents="none"
      testID={testID}
      style={[
        styles.bubble,
        positionStyle,
        {
          backgroundColor: theme.colors.bgElevated,
          borderColor: theme.colors.surfaceBorder,
          borderRadius: theme.radius.card,
        },
        webBackdropBlur(12),
        webShadow('0 8px 24px rgba(0, 0, 0, 0.55)'),
        webTransition(theme, 'opacity, transform', 150),
      ]}
    >
      <Text
        numberOfLines={2}
        style={[
          fontFamilyStyle,
          styles.contentText,
          {
            color: theme.colors.textPrimary,
            fontSize: Math.round(12 * theme.fontScale * 2) / 2,
          },
        ]}
      >
        {content}
      </Text>
      {description.length > 0 ? (
        <Text
          numberOfLines={2}
          style={[
            fontFamilyStyle,
            styles.descriptionText,
            {
              color: theme.colors.textSecondary,
              fontSize: Math.round(11 * theme.fontScale * 2) / 2,
            },
          ]}
        >
          {description}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Root-level overlay host mounted inside {@link ThemeProvider} so active tooltips render outside
 * `backdrop-filter`, `transform`, and `overflow: hidden` ancestors.
 */
export function TooltipHostProvider({
  theme,
  children,
}: {
  readonly theme: Theme;
  readonly children: ReactNode;
}): ReactElement {
  const [activeEntry, setActiveEntry] = useState<TooltipOverlayEntry | null>(null);

  const showTooltip = useCallback((entry: TooltipOverlayEntry) => {
    setActiveEntry(entry);
  }, []);

  const hideTooltip = useCallback((id: string) => {
    setActiveEntry((prev) => (prev !== null && prev.id === id ? null : prev));
  }, []);

  const controller = useMemo<TooltipHostController>(
    () => ({ showTooltip, hideTooltip }),
    [showTooltip, hideTooltip],
  );

  const rootPositionStyle: ViewStyle =
    activeEntry?.coords !== null && activeEntry?.coords !== undefined
      ? ({
          position: Platform.OS === 'web' ? 'fixed' : 'absolute',
          left: activeEntry.coords.left,
          top: activeEntry.coords.top,
        } as unknown as ViewStyle)
      : ({
          position: Platform.OS === 'web' ? 'fixed' : 'absolute',
          left: 8,
          top: 8,
        } as unknown as ViewStyle);

  return (
    <TooltipHostContext.Provider value={controller}>
      {children}
      {activeEntry !== null ? (
        <TooltipBubble
          theme={theme}
          content={activeEntry.content}
          description={activeEntry.description}
          positionStyle={rootPositionStyle}
          testID={activeEntry.testID}
        />
      ) : null}
    </TooltipHostContext.Provider>
  );
}

const styles = StyleSheet.create({
  bubble: {
    position: 'absolute',
    zIndex: 9999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: TOOLTIP_MAX_WIDTH_PX,
  },
  contentText: {
    fontWeight: '600',
    lineHeight: 16,
  },
  descriptionText: {
    fontWeight: '500',
    lineHeight: 15,
    marginTop: 2,
  },
});
