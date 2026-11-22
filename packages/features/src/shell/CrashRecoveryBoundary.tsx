import type { KeyEvent } from '@elv/focus-core';
import {
  TvFocusAnchor,
  useFormFactor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import {
  Component,
  type ErrorInfo,
  Fragment,
  type ReactElement,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouteActive } from '../shared';

const FALLBACK_ERROR_CODE = 'ERR_UNEXPECTED';
const SAFE_CODE_TOKEN = /^[A-Za-z0-9_.-]{1,48}$/;
const WEB_INTERACTIVE_ROLES = new Set(['button', 'link', 'radio', 'adjustable', 'switch']);

type WebActiveElement = { tagName?: unknown; getAttribute?: (n: string) => string | null };

function isWebInteractiveFocused(): boolean {
  if ((Platform.OS as string) !== 'web') return false;
  const active = (globalThis as { document?: { activeElement?: WebActiveElement } }).document
    ?.activeElement;
  if (!active) return false;
  if (typeof active.tagName === 'string' && active.tagName.toUpperCase() === 'BUTTON') return true;
  const role = active.getAttribute?.('role');
  return typeof role === 'string' && WEB_INTERACTIVE_ROLES.has(role.toLowerCase());
}

function sanitizeToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return SAFE_CODE_TOKEN.test(trimmed) ? trimmed : null;
}

/**
 * Extracts a strictly secret-free error reference (`category/code`, `code`, or `Error.name`)
 * without ever exposing raw error messages, stack traces, URLs, credentials, or query strings.
 */
export function formatRedactedErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return FALLBACK_ERROR_CODE;
  const record = error as { category?: unknown; code?: unknown; name?: unknown };
  const category = sanitizeToken(record.category);
  const code = sanitizeToken(record.code);
  if (category !== null && code !== null) return `${category}/${code}`;
  if (code !== null) return code;
  return sanitizeToken(record.name) ?? FALLBACK_ERROR_CODE;
}

/** Props of {@link CrashRecoveryBoundary}. */
export interface CrashRecoveryBoundaryProps {
  /** Invoked when the user triggers **Reload** (`crash-reload`). */
  readonly onReload?: () => void;
  /** Invoked when the user triggers **Clear UI Cache** (`crash-clear-cache`). */
  readonly onClearUiCache?: () => void;
  /** Invoked when the user triggers **Switch Source** (`crash-switch-source`). */
  readonly onSwitchSource?: () => void;
  /** Optional error observer invoked from `componentDidCatch`. */
  readonly onError?: (error: Error, info: ErrorInfo) => void;
  /** Changing this key clears an active crash state automatically (e.g. tab switch). */
  readonly resetKey?: string | number;
  /** Optional remount key applied to recovered children when Reload bumps it. */
  readonly remountKey?: string | number;
  /** Root container test identifier (defaults to `'crash-recovery-boundary'`). */
  readonly testID?: string;
  readonly children: ReactNode;
}

interface CrashRecoveryBoundaryState {
  readonly error: Error | null;
  readonly prevResetKey: string | number | undefined;
}

const ACTION_SPECS = [
  ['reload', 'crash-reload', 'crash.reload', true],
  ['clearCache', 'crash-clear-cache', 'crash.clearCache', false],
  ['switchSource', 'crash-switch-source', 'crash.switchSource', false],
] as const;

function RecoveryActionButton(props: {
  testID: string;
  label: string;
  primary: boolean;
  isTv: boolean;
  showFocusHalo: boolean;
  onActivate: () => void;
  onFocusIndex: () => void;
}): ReactElement {
  const theme = useTheme();
  const [hovered, setHovered] = useState(false);
  const { testID, label, primary, isTv, showFocusHalo, onActivate, onFocusIndex } = props;
  const foreground = primary ? theme.colors.ctaFg : theme.colors.textPrimary;
  const backgroundColor = primary
    ? theme.colors.ctaBg
    : showFocusHalo || hovered
      ? theme.colors.actionGlassHoverBg
      : theme.colors.actionGlassBg;
  const scale = showFocusHalo ? theme.focus.buttonScale : 1;
  const opacity = primary && hovered && !showFocusHalo ? 0.92 : 1;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: showFocusHalo }}
      {...(isTv ? { focusable: false } : {})}
      onPress={onActivate}
      onFocus={onFocusIndex}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.button,
        {
          backgroundColor,
          borderRadius: theme.radius.pill,
          borderWidth: primary ? 0 : 1,
          borderColor: primary ? 'transparent' : theme.colors.actionGlassBorder,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.sm,
          opacity,
          transform: [{ scale }],
        },
        !primary ? webBackdropBlur(12) : undefined,
        webTransition(theme, 'transform, background-color, border-color, opacity'),
        webCursorPointer(),
      ]}
    >
      <Text
        numberOfLines={1}
        style={[theme.typography.title, styles.buttonLabel, { color: foreground }]}
      >
        {label}
      </Text>
      {showFocusHalo ? (
        <View
          pointerEvents="none"
          testID={`${testID}-focus-ring`}
          style={[
            styles.focusRing,
            {
              borderRadius: theme.radius.pill,
              borderWidth: theme.focus.ringWidth,
              borderColor: theme.colors.focusRingColor,
            },
          ]}
        />
      ) : null}
    </Pressable>
  );
}

function CrashRecoveryFallback(props: {
  error: Error;
  onReload: () => void;
  onClearUiCache: () => void;
  onSwitchSource: () => void;
  testID: string;
}): ReactElement {
  const { error, onReload, onClearUiCache, onSwitchSource, testID } = props;
  const theme = useTheme();
  const i18n = useI18n();
  const formFactor = useFormFactor();
  const viewport = useViewport();
  const routeActive = useRouteActive();
  const isTv = formFactor === 'tv' || viewport.inputModality === 'tv';
  const isPortrait = viewport.orientation === 'portrait' && !isTv;
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [keyboardActive, setKeyboardActive] = useState(false);

  const handlers = { reload: onReload, clearCache: onClearUiCache, switchSource: onSwitchSource };
  const actions = ACTION_SPECS.map(([id, btnId, key, primary]) => ({
    id,
    testID: btnId,
    label: i18n.t(key),
    primary,
    onActivate: handlers[id],
  }));

  const navRef = useRef({ focusedIndex, actions, isTv });
  navRef.current = { focusedIndex, actions, isTv };

  const handleKeyEvent = useCallback((event: KeyEvent) => {
    if (event.kind !== 'press' && event.kind !== 'repeat') return;
    const { actions: list, focusedIndex: idx, isTv: tv } = navRef.current;
    if (
      event.key === 'right' ||
      event.key === 'down' ||
      event.key === 'left' ||
      event.key === 'up'
    ) {
      const delta = event.key === 'right' || event.key === 'down' ? 1 : -1;
      const next = (idx + delta + list.length) % list.length;
      navRef.current.focusedIndex = next;
      setKeyboardActive(true);
      setFocusedIndex(next);
    } else if (event.kind === 'press' && event.key === 'select') {
      if (!tv && isWebInteractiveFocused()) return;
      list[idx]?.onActivate();
    }
  }, []);

  useKeyInterpreter(handleKeyEvent);

  const redactedCode = formatRedactedErrorCode(error);
  const tvContainerProps = isTv ? { focusable: false } : {};

  return (
    <View
      testID={testID}
      {...tvContainerProps}
      style={[
        styles.root,
        {
          backgroundColor: theme.colors.bgCanvas,
          paddingHorizontal: Math.max(theme.spacing.lg, viewport.overscan.x),
          paddingVertical: Math.max(theme.spacing.lg, viewport.overscan.y),
        },
      ]}
    >
      {isTv ? (
        <TvFocusAnchor testID="crash-tv-focus-anchor" hasTVPreferredFocus={routeActive} />
      ) : null}
      <View
        {...tvContainerProps}
        style={[
          styles.panel,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.modal,
            padding: isPortrait ? theme.spacing.lg : theme.spacing.xl,
            maxWidth: isTv ? 640 : 540,
          },
        ]}
      >
        <View
          {...tvContainerProps}
          style={[
            styles.accentBar,
            {
              backgroundColor: theme.colors.accent,
              borderRadius: theme.radius.pill,
              marginBottom: theme.spacing.md,
            },
          ]}
        />
        <Text
          testID="crash-title"
          accessibilityRole="header"
          style={[theme.typography.h1, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('crash.title')}
        </Text>
        <Text
          testID="crash-subtitle"
          style={[
            theme.typography.body,
            { color: theme.colors.textSecondary, marginTop: theme.spacing.xs },
          ]}
        >
          {i18n.t('crash.subtitle')}
        </Text>
        <Text
          testID="crash-code"
          style={[
            theme.typography.caption,
            { color: theme.colors.textMuted, marginTop: theme.spacing.md },
          ]}
        >
          {i18n.t('crash.code', { code: redactedCode })}
        </Text>
        <View
          {...tvContainerProps}
          style={[
            styles.actionsRow,
            {
              flexDirection: isPortrait ? 'column' : 'row',
              gap: theme.spacing.sm,
              marginTop: theme.spacing.lg,
            },
          ]}
        >
          {actions.map((action, index) => (
            <RecoveryActionButton
              key={action.id}
              testID={action.testID}
              label={action.label}
              primary={action.primary}
              onActivate={action.onActivate}
              isTv={isTv}
              showFocusHalo={(isTv || keyboardActive) && focusedIndex === index}
              onFocusIndex={() => {
                navRef.current.focusedIndex = index;
                setKeyboardActive(true);
                setFocusedIndex(index);
              }}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

/**
 * Cinema Quietude TV-, keyboard-, and touch-navigable React Error Boundary (`#159`).
 *
 * Isolates render crashes behind three explicit recovery actions (`Reload`, `Clear UI Cache`,
 * `Switch Source`) with a strictly redacted error reference that never exposes raw URLs,
 * credentials, query strings, or stack traces.
 */
export class CrashRecoveryBoundary extends Component<
  CrashRecoveryBoundaryProps,
  CrashRecoveryBoundaryState
> {
  override state: CrashRecoveryBoundaryState = { error: null, prevResetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<CrashRecoveryBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: CrashRecoveryBoundaryProps,
    state: CrashRecoveryBoundaryState,
  ): Partial<CrashRecoveryBoundaryState> | null {
    return props.resetKey !== state.prevResetKey
      ? { error: null, prevResetKey: props.resetKey }
      : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private readonly handleReload = (): void => {
    this.setState({ error: null });
    this.props.onReload?.();
  };

  private readonly handleClearUiCache = (): void => {
    this.props.onClearUiCache?.();
    this.setState({ error: null });
  };

  private readonly handleSwitchSource = (): void => {
    this.props.onSwitchSource?.();
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    const { children, remountKey, testID } = this.props;
    if (error === null) {
      return remountKey !== undefined ? <Fragment key={remountKey}>{children}</Fragment> : children;
    }
    return (
      <CrashRecoveryFallback
        error={error}
        onReload={this.handleReload}
        onClearUiCache={this.handleClearUiCache}
        onSwitchSource={this.handleSwitchSource}
        testID={testID ?? 'crash-recovery-boundary'}
      />
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  panel: { width: '100%', borderWidth: 1 },
  accentBar: { width: 36, height: 3 },
  actionsRow: { flexWrap: 'wrap', alignItems: 'stretch' },
  button: {
    position: 'relative',
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: { fontWeight: '700' },
  focusRing: { position: 'absolute', top: -4, bottom: -4, left: -4, right: -4 },
});
