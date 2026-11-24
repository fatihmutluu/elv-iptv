import type { CatalogService, SourceRow } from '@elv/data';
import type { KeyInput } from '@elv/focus-core';
import type { MessageId } from '@elv/i18n';
import {
  CtaButton,
  QrCodeView,
  TABULAR_NUMS_STYLE,
  TvFocusAnchor,
  useI18n,
  useTheme,
  useTvKeyInterceptor,
  useTvKeySource,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type {
  LanPairingPort,
  LanPairingSession,
  LanPairingSourcePayload,
} from '../ports/lan-pairing-host';
import { describeSourceFailure } from './errors';

const NOOP_TV_SUBSCRIBER = (): boolean => false;
const COUNTDOWN_TICK_MS = 1_000;

/** Formats remaining milliseconds as `M:SS` for the QR pairing expiry badge. */
export function formatPairingCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1_000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Props of {@link QrPairingOverlay}. */
export interface QrPairingOverlayProps {
  readonly visible: boolean;
  readonly catalog: CatalogService;
  readonly lanPairing: LanPairingPort;
  /** Invoked once a paired source has been saved to the catalog so the caller can trigger import/refresh. */
  readonly onSourceAdded?: (source: SourceRow) => void;
  readonly onClose: () => void;
  /** Optional clock returning epoch ms for deterministic countdown tests. */
  readonly now?: () => number;
}

type OverlayPhase =
  | { readonly kind: 'starting' }
  | { readonly kind: 'ready'; readonly session: LanPairingSession }
  | { readonly kind: 'received' }
  | { readonly kind: 'error'; readonly messageId: MessageId; readonly hintId: MessageId }
  | { readonly kind: 'unavailable' };

function QrTvKeyTrap({
  onBack,
  onSelect,
  onSwitchFocus,
}: {
  readonly onBack: () => void;
  readonly onSelect: () => void;
  readonly onSwitchFocus: (dir: -1 | 1) => void;
}): ReactElement {
  const ref = useRef({ onBack, onSelect, onSwitchFocus });
  ref.current = { onBack, onSelect, onSwitchFocus };

  useTvKeySource(NOOP_TV_SUBSCRIBER);
  useTvKeyInterceptor((input: KeyInput) => {
    if (input.action !== 'down' && input.action !== 'press') return true;
    if (input.key === 'back') {
      ref.current.onBack();
      return true;
    }
    if (input.key === 'left') {
      ref.current.onSwitchFocus(-1);
      return true;
    }
    if (input.key === 'right') {
      ref.current.onSwitchFocus(1);
      return true;
    }
    if (input.key === 'select') {
      ref.current.onSelect();
      return true;
    }
    return true;
  });

  return <TvFocusAnchor testID="qr-pairing-tv-focus-anchor" hasTVPreferredFocus />;
}

/**
 * Cinema Quietude v2 in-tree Phone-to-TV LAN QR Pairing overlay (`#50`).
 * Never uses React Native `<Modal>`; manages ephemeral session lifecycle cleanly and closes on
 * first valid source submission, explicit Back/Close dismissal, or unmount.
 */
export function QrPairingOverlay({
  visible,
  catalog,
  lanPairing,
  onSourceAdded,
  onClose,
  now = Date.now,
}: QrPairingOverlayProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';

  const [phase, setPhase] = useState<OverlayPhase>({ kind: 'starting' });
  const [nowMs, setNowMs] = useState(() => now());
  const [focusedBtn, setFocusedBtn] = useState<'regenerate' | 'close'>('close');
  const [sessionEpoch, setSessionEpoch] = useState(0);

  const nowRef = useRef(now);
  nowRef.current = now;
  const callbacksRef = useRef({ onSourceAdded, onClose });
  callbacksRef.current = { onSourceAdded, onClose };
  const locale: 'en' | 'tr' = i18n.locale === 'tr' ? 'tr' : 'en';
  const localeRef = useRef(locale);
  localeRef.current = locale;

  const stopSessionSafely = useCallback(() => {
    void Promise.resolve(lanPairing.stopSession()).catch(() => undefined);
  }, [lanPairing]);

  const handleClose = useCallback(() => {
    stopSessionSafely();
    callbacksRef.current.onClose();
  }, [stopSessionSafely]);

  const handleRegenerate = useCallback(() => {
    setSessionEpoch((e) => e + 1);
  }, []);

  // Start ephemeral LAN session on open / regenerate and always tear down on close or unmount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionEpoch restarts a fresh pairing session
  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    let handledPayload = false;

    setPhase({ kind: 'starting' });
    setNowMs(nowRef.current());

    const unsubscribe = lanPairing.onPayloadReceived((payload: LanPairingSourcePayload) => {
      if (!alive || handledPayload) return;
      handledPayload = true;
      setPhase({ kind: 'received' });

      const addPromise =
        payload.kind === 'xtream'
          ? catalog.addSource({
              kind: 'xtream',
              name: payload.name,
              server: payload.server,
              username: payload.username,
              password: payload.password,
              ...(payload.guideUrl !== undefined && payload.guideUrl !== ''
                ? { guideUrl: payload.guideUrl }
                : {}),
            })
          : catalog.addSourceFromLink({
              name: payload.name,
              url: payload.url,
              ...(payload.guideUrl !== undefined && payload.guideUrl !== ''
                ? { guideUrl: payload.guideUrl }
                : {}),
            });

      void addPromise
        .then((res) => {
          stopSessionSafely();
          if (!alive) return;
          if (res.ok) {
            callbacksRef.current.onSourceAdded?.(res.value);
            callbacksRef.current.onClose();
            return;
          }
          const described = describeSourceFailure(res.error);
          setPhase({
            kind: 'error',
            messageId: described.messageId,
            hintId: described.hintId,
          });
        })
        .catch(() => {
          stopSessionSafely();
          if (alive) {
            setPhase({
              kind: 'error',
              messageId: 'source.error.storage',
              hintId: 'source.hint.storage',
            });
          }
        });
    });

    void lanPairing
      .startSession({ locale: localeRef.current })
      .then((session) => {
        if (!alive) {
          stopSessionSafely();
          return;
        }
        setNowMs(nowRef.current());
        setPhase({ kind: 'ready', session });
      })
      .catch(() => {
        if (alive) setPhase({ kind: 'unavailable' });
      });

    return () => {
      alive = false;
      unsubscribe();
      stopSessionSafely();
    };
  }, [catalog, lanPairing, sessionEpoch, stopSessionSafely, visible]);

  const activeSession = phase.kind === 'ready' ? phase.session : null;
  const remainingMs = activeSession !== null ? Math.max(0, activeSession.expiresAtMs - nowMs) : 0;
  const isExpired = activeSession !== null && remainingMs <= 0;

  useEffect(() => {
    if (!visible || activeSession === null || isExpired) return undefined;
    const timer = setInterval(() => {
      setNowMs(nowRef.current());
    }, COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, [activeSession, isExpired, visible]);

  useEffect(() => {
    if (!visible || (Platform.OS as string) !== 'web') return undefined;
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
    };
    const onKeyDown = (e: { key?: string; preventDefault?: () => void }) => {
      if (e.key === 'Escape') {
        e.preventDefault?.();
        handleClose();
      }
    };
    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [handleClose, visible]);

  const showRegenerate = isExpired || phase.kind === 'unavailable' || phase.kind === 'error';
  useEffect(() => {
    setFocusedBtn(showRegenerate ? 'regenerate' : 'close');
  }, [showRegenerate]);

  const handleTvSwitchFocus = useCallback(
    (dir: -1 | 1) => {
      if (!showRegenerate) {
        setFocusedBtn('close');
        return;
      }
      setFocusedBtn(dir < 0 ? 'regenerate' : 'close');
    },
    [showRegenerate],
  );

  const handleTvSelect = useCallback(() => {
    if (showRegenerate && focusedBtn === 'regenerate') {
      handleRegenerate();
    } else {
      handleClose();
    }
  }, [focusedBtn, handleClose, handleRegenerate, showRegenerate]);

  if (!visible) return null;

  return (
    <View testID="qr-pairing-overlay" style={styles.root}>
      {isTv ? (
        <QrTvKeyTrap
          onBack={handleClose}
          onSelect={handleTvSelect}
          onSwitchFocus={handleTvSwitchFocus}
        />
      ) : null}
      <Pressable
        testID="qr-pairing-backdrop"
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={i18n.t('sources.qr.close')}
        onPress={handleClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlayBackdrop }]}
      />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={styles.headerBlock}>
          <Text
            style={[theme.typography.h2, styles.centerText, { color: theme.colors.textPrimary }]}
          >
            {i18n.t('sources.qr.title')}
          </Text>
          <Text
            style={[
              theme.typography.body,
              styles.centerText,
              { color: theme.colors.textSecondary },
            ]}
          >
            {i18n.t('sources.qr.subtitle')}
          </Text>
        </View>

        {phase.kind === 'received' ? (
          <Text
            testID="qr-pairing-received"
            style={[
              theme.typography.title,
              styles.centerText,
              { color: theme.colors.successColor },
            ]}
          >
            {i18n.t('sources.qr.received')}
          </Text>
        ) : phase.kind === 'error' ? (
          <View style={styles.errorBlock}>
            <Text
              testID="qr-pairing-error"
              style={[theme.typography.title, styles.centerText, { color: theme.colors.liveColor }]}
            >
              {i18n.t(phase.messageId)}
            </Text>
            <Text
              testID="qr-pairing-error-hint"
              style={[
                theme.typography.caption,
                styles.centerText,
                { color: theme.colors.textSecondary },
              ]}
            >
              {i18n.t(phase.hintId)}
            </Text>
          </View>
        ) : phase.kind === 'unavailable' ? (
          <Text
            testID="qr-pairing-unavailable"
            style={[theme.typography.body, styles.centerText, { color: theme.colors.liveColor }]}
          >
            {i18n.t('sources.qr.unavailable')}
          </Text>
        ) : activeSession !== null ? (
          <View style={styles.qrBody}>
            {!isExpired ? (
              <>
                <QrCodeView
                  value={activeSession.url}
                  size={220}
                  testID="qr-pairing-code"
                  accessibilityLabel={i18n.t('sources.qr.scanHint')}
                />
                <Text
                  style={[
                    theme.typography.caption,
                    styles.centerText,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  {i18n.t('sources.qr.orVisit')}
                </Text>
                <Text
                  testID="qr-pairing-url"
                  selectable
                  style={[
                    theme.typography.body,
                    styles.centerText,
                    styles.urlText,
                    {
                      color: theme.colors.textPrimary,
                      backgroundColor: theme.colors.bgCard,
                      borderColor: theme.colors.surfaceBorder,
                      borderRadius: theme.radius.button,
                    },
                  ]}
                >
                  {activeSession.url}
                </Text>
                <Text
                  testID="qr-pairing-countdown"
                  style={[
                    theme.typography.caption,
                    TABULAR_NUMS_STYLE,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  {i18n.t('sources.qr.expiresIn', {
                    time: formatPairingCountdown(remainingMs),
                  })}
                </Text>
                <Text
                  testID="qr-pairing-waiting"
                  style={[theme.typography.caption, { color: theme.colors.textMuted }]}
                >
                  {i18n.t('sources.qr.waiting')}
                </Text>
              </>
            ) : (
              <Text
                testID="qr-pairing-expired"
                style={[
                  theme.typography.title,
                  styles.centerText,
                  { color: theme.colors.liveColor },
                ]}
              >
                {i18n.t('sources.qr.expired')}
              </Text>
            )}
          </View>
        ) : (
          <Text
            testID="qr-pairing-waiting"
            style={[theme.typography.body, styles.centerText, { color: theme.colors.textMuted }]}
          >
            {i18n.t('sources.qr.waiting')}
          </Text>
        )}

        <Text
          testID="qr-pairing-lan-note"
          style={[theme.typography.caption, styles.centerText, { color: theme.colors.textMuted }]}
        >
          {i18n.t('sources.qr.lanOnlyNote')}
        </Text>

        <View style={styles.actionsRow}>
          {showRegenerate ? (
            <CtaButton
              testID="qr-pairing-regenerate-btn"
              label={i18n.t('sources.qr.regenerate')}
              variant="primary"
              focusable={!isTv}
              focused={isTv && focusedBtn === 'regenerate'}
              onPress={handleRegenerate}
            />
          ) : null}
          <CtaButton
            testID="qr-pairing-close-btn"
            label={i18n.t('sources.qr.close')}
            variant="secondary"
            focusable={!isTv}
            focused={isTv && focusedBtn === 'close'}
            onPress={handleClose}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 58,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 460,
    borderWidth: 1,
    padding: 24,
    gap: 14,
    alignItems: 'center',
  },
  headerBlock: { gap: 4, alignItems: 'center' },
  errorBlock: { gap: 6, alignItems: 'center' },
  qrBody: { alignItems: 'center', gap: 10, width: '100%' },
  urlText: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  centerText: { textAlign: 'center' },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 4,
  },
});
