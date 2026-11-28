import { PIN_LOCKOUT_MS, type PinVerifyResult } from '@elv/data';
import type { Result } from '@elv/domain';
import type { KeyEvent, KeyInput } from '@elv/focus-core';
import {
  CtaButton,
  Icon,
  TABULAR_NUMS_STYLE,
  TvFocusAnchor,
  useFormFactor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useTvKeyInterceptor,
  useTvKeySource,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PinDialogMode } from '../shared';

const MIN_PIN_LENGTH = 4;
const MAX_PIN_LENGTH = 8;
const PIN_DOT_SLOTS = [
  'slot-0',
  'slot-1',
  'slot-2',
  'slot-3',
  'slot-4',
  'slot-5',
  'slot-6',
  'slot-7',
] as const;

type KeypadKey = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'clear' | '0' | 'back';

const KEYPAD_ROWS: readonly (readonly KeypadKey[])[] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['clear', '0', 'back'],
];

type FlowStep = 'verify' | 'verify-old' | 'create' | 'confirm' | 'remove';

/** Props of {@link PinEntryOverlay}. */
export interface PinEntryOverlayProps {
  readonly mode: PinDialogMode;
  readonly title?: string;
  /** When `true` in `verify` mode, labels the submit action as verification rather than session unlock. */
  readonly verifyOnly?: boolean;
  readonly onVerify?: (pin: string) => Promise<PinVerifyResult>;
  /** Pure PIN verifier used in `change` mode's current-PIN step without unlocking parental state. */
  readonly onVerifyCurrentPin?: (pin: string) => Promise<PinVerifyResult>;
  readonly onSetPin?: (pin: string, currentPin?: string) => Promise<Result<void>>;
  readonly onClearPin?: (currentPin: string) => Promise<Result<void>>;
  readonly onSuccess: () => void;
  readonly onCancel: () => void;
  readonly testID?: string;
}

function initialStepForMode(mode: PinDialogMode): FlowStep {
  if (mode === 'create') return 'create';
  if (mode === 'change') return 'verify-old';
  if (mode === 'remove') return 'remove';
  return 'verify';
}

const NOOP_TV_SUBSCRIBER = (): boolean => false;

function useExclusiveTvKeySource(
  onInput: ((input: KeyInput) => boolean | undefined) | ((input: KeyInput) => void),
): void {
  // Keep TvRemoteProvider's lazy platform listener attached even if no screen underneath subscribes.
  useTvKeySource(NOOP_TV_SUBSCRIBER);
  useTvKeyInterceptor((input) => {
    onInput(input);
    return true;
  });
}

function PinTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: (event: KeyEvent) => boolean;
}): ReactElement {
  useKeyInterpreter(onEvent, { keySource: useExclusiveTvKeySource });
  return <TvFocusAnchor testID="pin-overlay-tv-focus-anchor" hasTVPreferredFocus />;
}

/**
 * In-tree Cinema Quietude v2 masked PIN entry overlay (`#31`).
 * Uses ZERO React Native `<Modal>` so TV D-pad focus and Back dismissal remain 100% deterministic.
 * Supports `verify`, `create`, `change`, and `remove` modes across TV D-pad, touch, and desktop keyboard.
 */
export function PinEntryOverlay({
  mode,
  title,
  verifyOnly = false,
  onVerify,
  onVerifyCurrentPin,
  onSetPin,
  onClearPin,
  onSuccess,
  onCancel,
  testID = 'pin-entry-overlay',
}: PinEntryOverlayProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const formFactor = useFormFactor();
  const viewport = useViewport();
  const isTv = formFactor === 'tv';
  const isWeb = (Platform.OS as string) === 'web';

  const [step, setStep] = useState<FlowStep>(() => initialStepForMode(mode));
  const [digits, setDigits] = useState('');
  const [pendingOldPin, setPendingOldPin] = useState<string | undefined>(undefined);
  const [pendingNewPin, setPendingNewPin] = useState<string | undefined>(undefined);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lockedUntilMs, setLockedUntilMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);

  // TV 2D focus coordinate: rows 0..3 are 3-column keypad, row 4 is [cancel, submit]
  const [focusCoord, setFocusCoord] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const focusCoordRef = useRef(focusCoord);
  focusCoordRef.current = focusCoord;

  useEffect(() => {
    setStep(initialStepForMode(mode));
    setDigits('');
    setPendingOldPin(undefined);
    setPendingNewPin(undefined);
    setErrorMsg(null);
    setLockedUntilMs(null);
    setSubmitting(false);
    setFocusCoord({ row: 0, col: 0 });
  }, [mode]);

  useEffect(() => {
    if (lockedUntilMs === null) return undefined;
    if (lockedUntilMs <= Date.now()) {
      setLockedUntilMs(null);
      return undefined;
    }
    const timer = setInterval(() => {
      const current = Date.now();
      setNowMs(current);
      if (current >= lockedUntilMs) {
        setLockedUntilMs(null);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [lockedUntilMs]);

  const lockoutSeconds =
    lockedUntilMs !== null && lockedUntilMs > nowMs
      ? Math.max(1, Math.ceil((lockedUntilMs - nowMs) / 1000))
      : 0;
  const isLockedOut = lockoutSeconds > 0;

  const appendDigit = useCallback((digit: string) => {
    setErrorMsg(null);
    setDigits((prev) => (prev.length >= MAX_PIN_LENGTH ? prev : `${prev}${digit}`));
  }, []);

  const backspace = useCallback(() => {
    setErrorMsg(null);
    setDigits((prev) => prev.slice(0, -1));
  }, []);

  const clearDigits = useCallback(() => {
    setErrorMsg(null);
    setDigits('');
  }, []);

  const handleSubmit = useCallback(async () => {
    if (submitting || isLockedOut) return;
    if (digits.length < MIN_PIN_LENGTH || digits.length > MAX_PIN_LENGTH) {
      setErrorMsg(i18n.t('parental.pinInvalid'));
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      if (step === 'verify') {
        const res = (await onVerify?.(digits)) ?? { ok: false, remainingAttempts: 0 };
        if (res.ok) {
          setDigits('');
          onSuccess();
          return;
        }
        setDigits('');
        if (res.lockedUntilMs !== undefined && res.lockedUntilMs > Date.now()) {
          setNowMs(Date.now());
          setLockedUntilMs(res.lockedUntilMs);
        } else {
          setErrorMsg(i18n.t('parental.pinWrong'));
        }
        return;
      }

      if (step === 'verify-old') {
        const res = (await (onVerifyCurrentPin ?? onVerify)?.(digits)) ?? {
          ok: false,
          remainingAttempts: 0,
        };
        if (res.ok) {
          setPendingOldPin(digits);
          setDigits('');
          setStep('create');
          return;
        }
        setDigits('');
        if (res.lockedUntilMs !== undefined && res.lockedUntilMs > Date.now()) {
          setNowMs(Date.now());
          setLockedUntilMs(res.lockedUntilMs);
        } else {
          setErrorMsg(i18n.t('parental.pinWrong'));
        }
        return;
      }

      if (step === 'create') {
        setPendingNewPin(digits);
        setDigits('');
        setStep('confirm');
        return;
      }

      if (step === 'confirm') {
        if (digits !== pendingNewPin) {
          setPendingNewPin(undefined);
          setDigits('');
          setStep('create');
          setErrorMsg(i18n.t('parental.pinMismatch'));
          return;
        }
        const res = await onSetPin?.(digits, pendingOldPin);
        if (res?.ok) {
          setDigits('');
          setPendingNewPin(undefined);
          setPendingOldPin(undefined);
          onSuccess();
          return;
        }
        setDigits('');
        if (res !== undefined && !res.ok && res.error.code === 'pin-locked') {
          const now = Date.now();
          setNowMs(now);
          setLockedUntilMs(now + PIN_LOCKOUT_MS);
        } else {
          setErrorMsg(i18n.t('parental.pinWrong'));
        }
        return;
      }

      if (step === 'remove') {
        const res = await onClearPin?.(digits);
        if (res?.ok) {
          setDigits('');
          onSuccess();
          return;
        }
        setDigits('');
        if (res !== undefined && !res.ok && res.error.code === 'pin-locked') {
          const now = Date.now();
          setNowMs(now);
          setLockedUntilMs(now + PIN_LOCKOUT_MS);
        } else {
          setErrorMsg(i18n.t('parental.pinWrong'));
        }
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    digits,
    i18n,
    isLockedOut,
    onClearPin,
    onSetPin,
    onSuccess,
    onVerify,
    onVerifyCurrentPin,
    pendingNewPin,
    pendingOldPin,
    step,
    submitting,
  ]);

  const handleKeyPress = useCallback(
    (key: KeypadKey) => {
      if (key === 'clear') {
        clearDigits();
      } else if (key === 'back') {
        backspace();
      } else {
        appendDigit(key);
      }
    },
    [appendDigit, backspace, clearDigits],
  );

  // Desktop/web physical keyboard digit, Backspace, Enter, and Escape support.
  // Skipped on Web-TV (`isTv === true`) where `Enter` is D-pad `select` handled by TvRemoteProvider.
  useEffect(() => {
    if (!isWeb || isTv) return undefined;
    type WebKeyEvent = {
      key?: string;
      preventDefault?: () => void;
      stopPropagation?: () => void;
      stopImmediatePropagation?: () => void;
    };
    const host = globalThis as unknown as {
      addEventListener?: (
        type: string,
        listener: (e: WebKeyEvent) => void,
        capture?: boolean,
      ) => void;
      removeEventListener?: (
        type: string,
        listener: (e: WebKeyEvent) => void,
        capture?: boolean,
      ) => void;
    };
    if (
      typeof host.addEventListener !== 'function' ||
      typeof host.removeEventListener !== 'function'
    ) {
      return undefined;
    }
    const consume = (event: WebKeyEvent) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
    };
    const onKeyDown = (event: WebKeyEvent) => {
      const key = event.key;
      if (typeof key === 'string' && key.length === 1 && key >= '0' && key <= '9') {
        consume(event);
        appendDigit(key);
      } else if (key === 'Backspace') {
        consume(event);
        backspace();
      } else if (key === 'Enter') {
        consume(event);
        void handleSubmit();
      } else if (key === 'Escape') {
        consume(event);
        onCancel();
      }
    };
    host.addEventListener('keydown', onKeyDown, true);
    return () => host.removeEventListener?.('keydown', onKeyDown, true);
  }, [appendDigit, backspace, handleSubmit, isTv, isWeb, onCancel]);

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind === 'press' && event.key === 'back') {
        onCancel();
        return true;
      }
      if (event.kind === 'press' && event.key.startsWith('digit') && event.key.length === 6) {
        const d = event.key[5];
        if (d !== undefined && d >= '0' && d <= '9') {
          appendDigit(d);
          return true;
        }
      }
      if (event.kind !== 'press' && event.kind !== 'repeat') return false;
      const cur = focusCoordRef.current;
      if (event.key === 'up') {
        const nextRow = Math.max(0, cur.row - 1);
        const maxCol = nextRow === 4 ? 1 : 2;
        setFocusCoord({ row: nextRow, col: Math.min(cur.col, maxCol) });
        return true;
      }
      if (event.key === 'down') {
        const nextRow = Math.min(4, cur.row + 1);
        const maxCol = nextRow === 4 ? 1 : 2;
        setFocusCoord({ row: nextRow, col: Math.min(cur.col, maxCol) });
        return true;
      }
      if (event.key === 'left') {
        setFocusCoord({ row: cur.row, col: Math.max(0, cur.col - 1) });
        return true;
      }
      if (event.key === 'right') {
        const maxCol = cur.row === 4 ? 1 : 2;
        setFocusCoord({ row: cur.row, col: Math.min(maxCol, cur.col + 1) });
        return true;
      }
      if (event.kind === 'press' && event.key === 'select') {
        if (cur.row === 4) {
          if (cur.col === 0) onCancel();
          else void handleSubmit();
          return true;
        }
        const key = KEYPAD_ROWS[cur.row]?.[cur.col];
        if (key !== undefined) handleKeyPress(key);
        return true;
      }
      return false;
    },
    [appendDigit, handleKeyPress, handleSubmit, onCancel],
  );

  const heading = useMemo(() => {
    if (title !== undefined && step === 'verify') return title;
    if (step === 'create') return i18n.t('parental.createPin');
    if (step === 'confirm') return i18n.t('parental.confirmPin');
    if (step === 'remove') return i18n.t('parental.removePin');
    if (step === 'verify-old') return i18n.t('parental.changePin');
    return verifyOnly ? i18n.t('parental.reverifyTitle') : i18n.t('parental.unlockTitle');
  }, [i18n, step, title, verifyOnly]);

  const subtitle = useMemo(() => {
    if (step === 'verify-old' || step === 'remove' || step === 'verify') {
      return i18n.t('parental.enterPin');
    }
    if (step === 'confirm') return i18n.t('parental.confirmPin');
    return i18n.t('parental.createPin');
  }, [i18n, step]);

  const submitLabel =
    step === 'verify'
      ? verifyOnly
        ? i18n.t('parental.verifyButton')
        : i18n.t('parental.unlockButton')
      : step === 'remove'
        ? i18n.t('parental.removePin')
        : i18n.t('profiles.save');

  const displayError = isLockedOut
    ? i18n.t('parental.pinLockedOut', { seconds: lockoutSeconds })
    : errorMsg;

  const keyTransition = webTransition(theme, 'background-color, border-color, transform');
  const cursorPointer = webCursorPointer();

  return (
    <View
      testID={testID}
      style={[
        styles.backdrop,
        {
          backgroundColor: theme.colors.overlayBackdrop,
          paddingHorizontal: 20 + viewport.overscan.x,
          paddingVertical: 20 + viewport.overscan.y,
        },
      ]}
    >
      {isTv ? <PinTvKeyBridge onEvent={handleTvKey} /> : null}

      <View
        testID="pin-entry-panel"
        style={[
          styles.panel,
          isTv ? styles.panelTv : null,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={styles.headerRow}>
          <Icon name="lock" size={20} color={theme.colors.accent} />
          <View style={styles.headerText}>
            <Text
              testID="pin-entry-title"
              style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
            >
              {heading}
            </Text>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {subtitle}
            </Text>
          </View>
        </View>

        <View
          testID="pin-entry-dots"
          accessibilityLabel={`${digits.length}`}
          style={styles.dotsRow}
        >
          {PIN_DOT_SLOTS.slice(0, Math.max(MIN_PIN_LENGTH, digits.length)).map((slotId, idx) => {
            const filled = idx < digits.length;
            return (
              <View
                key={slotId}
                style={[
                  styles.dot,
                  {
                    borderRadius: theme.radius.pill,
                    backgroundColor: filled ? theme.colors.accent : theme.colors.bgCard,
                    borderColor: filled ? theme.colors.accent : theme.colors.chipBorder,
                  },
                ]}
              />
            );
          })}
        </View>

        {displayError !== null ? (
          <Text
            testID="pin-entry-error"
            accessibilityLiveRegion="polite"
            style={[
              theme.typography.caption,
              TABULAR_NUMS_STYLE,
              styles.errorText,
              { color: theme.colors.liveColor },
            ]}
          >
            {displayError}
          </Text>
        ) : null}

        <View testID="pin-entry-keypad" style={styles.keypad}>
          {KEYPAD_ROWS.map((row, rowIdx) => (
            <View key={row.join('-')} style={styles.keypadRow}>
              {row.map((key, colIdx) => {
                const focused = isTv && focusCoord.row === rowIdx && focusCoord.col === colIdx;
                const label =
                  key === 'clear'
                    ? i18n.t('parental.clear')
                    : key === 'back'
                      ? i18n.t('parental.backspace')
                      : key;
                return (
                  <Pressable
                    key={key}
                    testID={`pin-key-${key}`}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    disabled={isLockedOut || submitting}
                    {...(isTv ? { focusable: false } : {})}
                    onPress={() => handleKeyPress(key)}
                    style={[
                      styles.keyButton,
                      keyTransition,
                      cursorPointer,
                      {
                        borderRadius: theme.radius.button,
                        backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgSurface,
                        borderWidth: focused ? theme.focus.ringWidth : 1,
                        borderColor: focused
                          ? theme.colors.focusRingColor
                          : theme.colors.surfaceBorder,
                      },
                    ]}
                  >
                    <Text
                      numberOfLines={1}
                      style={[
                        key === 'clear' || key === 'back'
                          ? theme.typography.caption
                          : theme.typography.h2,
                        TABULAR_NUMS_STYLE,
                        { color: theme.colors.textPrimary },
                      ]}
                    >
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>

        <View style={styles.actions}>
          <CtaButton
            testID="pin-entry-cancel"
            variant="secondary"
            label={i18n.t('profiles.cancel')}
            focused={isTv && focusCoord.row === 4 && focusCoord.col === 0}
            focusable={!isTv}
            onPress={onCancel}
            style={styles.actionBtn}
          />
          <CtaButton
            testID="pin-entry-submit"
            variant="primary"
            label={submitLabel}
            disabled={isLockedOut || submitting || digits.length < MIN_PIN_LENGTH}
            focused={isTv && focusCoord.row === 4 && focusCoord.col === 1}
            focusable={!isTv}
            onPress={() => {
              void handleSubmit();
            }}
            style={styles.actionBtn}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 55,
  },
  panel: {
    width: '100%',
    maxWidth: 380,
    borderWidth: 1,
    padding: 20,
    gap: 14,
  },
  panelTv: {
    maxWidth: 440,
    padding: 26,
    gap: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  dot: {
    width: 14,
    height: 14,
    borderWidth: 1.5,
  },
  errorText: {
    textAlign: 'center',
  },
  keypad: {
    gap: 8,
  },
  keypadRow: {
    flexDirection: 'row',
    gap: 8,
  },
  keyButton: {
    flex: 1,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingTop: 4,
  },
  actionBtn: {
    flex: 1,
    minHeight: 42,
  },
});
