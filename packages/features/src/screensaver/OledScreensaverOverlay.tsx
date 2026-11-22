import { TABULAR_NUMS_STYLE, useI18n, useTheme, useTvKeyInterceptor } from '@elv/ui-kit';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { OledScreensaverSnapshot } from './screensaver-controller';

/** Pure zero-luminance OLED black pixel constant (`#160`). */
export const OLED_PURE_BLACK = '#000000';

function formatScreensaverClockHm(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '--:--';
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Props of {@link OledScreensaverOverlay}. */
export interface OledScreensaverOverlayProps {
  readonly state: OledScreensaverSnapshot;
  readonly wallClock?: () => number;
  readonly onWake: () => void;
}

/**
 * Full-screen pure `#000000` OLED screensaver with slowly drifting dim clock & brand wordmark
 * (`#160`). Consumes the wake interaction and shields underlying UI during the 260 ms wake window
 * so menus or buttons underneath are never accidentally clicked.
 */
export function OledScreensaverOverlay({
  state,
  wallClock = Date.now,
  onWake,
}: OledScreensaverOverlayProps): ReactElement | null {
  const i18n = useI18n();
  const theme = useTheme();
  const [clockText, setClockText] = useState(() => formatScreensaverClockHm(wallClock()));
  const priorWebFocusRef = useRef<{ focus?: () => void; isConnected?: boolean } | null>(null);
  const wasActiveRef = useRef(false);

  useEffect(() => {
    if ((Platform.OS as string) !== 'web') {
      wasActiveRef.current = state.active;
      return;
    }
    const doc = (
      globalThis as {
        document?: { activeElement?: { focus?: () => void; isConnected?: boolean } | null };
      }
    ).document;
    if (state.active && !wasActiveRef.current) {
      priorWebFocusRef.current = doc?.activeElement ?? null;
    } else if (!state.active && wasActiveRef.current) {
      const prev = priorWebFocusRef.current;
      priorWebFocusRef.current = null;
      if (prev && prev.isConnected !== false) {
        prev.focus?.();
      }
    }
    wasActiveRef.current = state.active;
  }, [state.active]);

  useEffect(() => {
    if (!state.active) return;
    setClockText(formatScreensaverClockHm(wallClock()));
    const handle = setInterval(() => {
      setClockText(formatScreensaverClockHm(wallClock()));
    }, 15_000);
    return () => clearInterval(handle);
  }, [state.active, wallClock]);

  useTvKeyInterceptor((input) => {
    if (!state.active && !state.wakeSuppressed) return false;
    if (
      state.active &&
      (input.action === 'down' || input.action === 'press' || input.action === 'up')
    ) {
      onWake();
    }
    return true;
  });

  useEffect(() => {
    if ((!state.active && !state.wakeSuppressed) || (Platform.OS as string) !== 'web') return;
    const win = (
      globalThis as {
        window?: {
          addEventListener?: (
            t: string,
            fn: (e: { preventDefault?: () => void; stopPropagation?: () => void }) => void,
            capture?: boolean,
          ) => void;
          removeEventListener?: (
            t: string,
            fn: (e: { preventDefault?: () => void; stopPropagation?: () => void }) => void,
            capture?: boolean,
          ) => void;
        };
      }
    ).window;
    if (!win?.addEventListener || !win.removeEventListener) return;
    const onKeyDown = (e: { preventDefault?: () => void; stopPropagation?: () => void }): void => {
      e.preventDefault?.();
      e.stopPropagation?.();
      if (state.active) onWake();
    };
    win.addEventListener('keydown', onKeyDown, true);
    return () => win.removeEventListener?.('keydown', onKeyDown, true);
  }, [onWake, state.active, state.wakeSuppressed]);

  if (state.active) {
    return (
      <Pressable
        testID="oled-screensaver-overlay"
        accessibilityRole="button"
        accessibilityLabel={i18n.t('screensaver.title')}
        accessibilityHint={i18n.t('screensaver.wakeHint')}
        focusable
        hasTVPreferredFocus
        onPress={onWake}
        onStartShouldSetResponder={() => true}
        onResponderRelease={onWake}
        style={[styles.overlay, { backgroundColor: OLED_PURE_BLACK }]}
      >
        <View
          testID="oled-screensaver-drift-anchor"
          pointerEvents="none"
          style={[
            styles.driftBox,
            {
              left: `${state.xPct}%`,
              top: `${state.yPct}%`,
            },
          ]}
        >
          <Text
            testID="oled-screensaver-clock"
            style={[TABULAR_NUMS_STYLE, styles.clock, { color: theme.colors.textSecondary }]}
          >
            {clockText}
          </Text>
          <Text
            testID="oled-screensaver-brand"
            style={[theme.typography.caption, styles.brand, { color: theme.colors.textMuted }]}
          >
            {i18n.t('app.title')}
          </Text>
          <Text style={[theme.typography.micro, styles.hint, { color: theme.colors.textMuted }]}>
            {i18n.t('screensaver.wakeHint')}
          </Text>
        </View>
      </Pressable>
    );
  }

  if (state.wakeSuppressed) {
    return (
      <Pressable
        testID="oled-screensaver-wake-shield"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onPress={() => undefined}
        style={styles.wakeShield}
      />
    );
  }

  return null;
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 9999,
  },
  wakeShield: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 9999,
    backgroundColor: 'transparent',
  },
  driftBox: {
    position: 'absolute',
    alignItems: 'center',
    width: 240,
    marginLeft: -120,
    marginTop: -44,
    gap: 6,
  },
  clock: {
    fontSize: 44,
    fontWeight: '300',
    letterSpacing: 1.5,
    opacity: 0.55,
  },
  brand: {
    letterSpacing: 2,
    opacity: 0.38,
  },
  hint: {
    opacity: 0.3,
  },
});
