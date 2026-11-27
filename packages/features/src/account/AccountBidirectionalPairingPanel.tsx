import type { MessageId } from '@elv/i18n';
import {
  CtaButton,
  QrCodeView,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  useViewport,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type {
  BidirectionalPairingSnapshot,
  QrScannerPort,
  SyncAccountPort,
} from '../ports/wave-f9-ports';
import {
  BidirectionalPairingSasCard,
  BidirectionalPairingTerminalView,
  shouldShowSasConfirmCard,
  shouldShowWaitingCard,
} from './AccountBidirectionalPairingViews';
import { AccountQrPairingView, AccountTextField } from './AccountFormParts';
import {
  mapSyncErrorCodeToMessageId,
  QR_POLL_INTERVAL_MS,
  useSyncQrPairing,
} from './account-helpers';

const PAIR_URI_RE = /^(?:elviptv|https?):\/\//i;
const TERMINAL_STATUSES = new Set<string>(['completed', 'rejected', 'expired', 'locked']);
const ACTIVE_STATUSES = new Set<string>([
  'pending',
  'responder_joined',
  'responder_transferred',
  'awaiting_sas',
  'waiting_approval',
  'approved',
]);

function isNonTerminalStatus(status: string): boolean {
  return !TERMINAL_STATUSES.has(status);
}

function cancelPairingBestEffort(
  syncAccount: SyncAccountPort,
  pairingId: string | undefined,
): void {
  if (!pairingId || syncAccount.cancelBidirectionalPairing === undefined) return;
  void Promise.resolve(syncAccount.cancelBidirectionalPairing(pairingId)).catch(() => undefined);
}

/** Formats an 8-digit pairing code as `1234 5678` for living-room legibility. */
export function formatPairingCodeDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 8) {
    return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  }
  return raw.trim();
}

function formatCodeInputText(raw: string): string {
  const trimmed = raw.trimStart();
  if (PAIR_URI_RE.test(trimmed)) return raw;
  const digitsOnly = raw.replace(/[\s-]/g, '');
  if (/^\d+$/.test(digitsOnly) && digitsOnly.length <= 8) {
    return digitsOnly.length > 4 ? `${digitsOnly.slice(0, 4)} ${digitsOnly.slice(4)}` : digitsOnly;
  }
  return raw;
}

function normalizePairingInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (PAIR_URI_RE.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[\s-]/g, '');
  return /^\d{8}$/.test(digits) ? digits : null;
}

/** Props of {@link AccountBidirectionalPairingPanel}. */
export interface AccountBidirectionalPairingPanelProps {
  readonly syncAccount: SyncAccountPort;
  /** Whether hosting/polling is currently active (defaults to `true`). */
  readonly active?: boolean;
  /** Optional native camera QR scanner port (`#510`). */
  readonly qrScanner?: QrScannerPort;
  /** Incoming `elviptv://pair?...` or Universal Link URI to join automatically (`#510`). */
  readonly pendingPairUri?: string | null;
  /** Invoked once `pendingPairUri` has been consumed. */
  readonly onPairUriHandled?: () => void;
  /** Invoked when pairing completes cleanly. */
  readonly onPaired?: () => void;
  /** Optional polling interval override (ms) for deterministic unit tests. */
  readonly pollIntervalMs?: number;
  /** QR pixel size (defaults to `180`). */
  readonly qrSize?: number;
  /** Prefix for legacy fallback QR testIDs (defaults to `'pair-qr'`). */
  readonly legacyTestIDPrefix?: string;
  /** Whether to suppress legacy QR hosting when signed in without bidirectional support. */
  readonly disableLegacyHost?: boolean;
}

/**
 * Unified Single-QR + 8-Digit Code Bidirectional X25519 Pairing panel (`#510`, `[1.45]`).
 * Supports hosting QR + 8-digit code, entering an 8-digit code or scanning a QR code,
 * automatic deep-link URI join, 4-digit SAS verification, and all 5 bidirectional cases.
 */
export function AccountBidirectionalPairingPanel({
  syncAccount,
  active = true,
  qrScanner,
  pendingPairUri,
  onPairUriHandled,
  onPaired,
  pollIntervalMs = QR_POLL_INTERVAL_MS,
  qrSize = 180,
  legacyTestIDPrefix = 'pair-qr',
  disableLegacyHost = false,
}: AccountBidirectionalPairingPanelProps): ReactElement {
  const supportsBidirectional =
    syncAccount.startBidirectionalPairing !== undefined &&
    syncAccount.joinBidirectionalPairing !== undefined;

  const legacyPairing = useSyncQrPairing(
    syncAccount,
    active && !supportsBidirectional && !disableLegacyHost,
    onPaired,
    pollIntervalMs,
  );

  if (!supportsBidirectional) {
    return (
      <AccountQrPairingView
        pairing={legacyPairing}
        size={qrSize}
        testIDPrefix={legacyTestIDPrefix}
      />
    );
  }

  return (
    <BidirectionalPairingContent
      syncAccount={syncAccount}
      active={active}
      {...(qrScanner !== undefined ? { qrScanner } : {})}
      {...(pendingPairUri !== undefined ? { pendingPairUri } : {})}
      {...(onPairUriHandled !== undefined ? { onPairUriHandled } : {})}
      {...(onPaired !== undefined ? { onPaired } : {})}
      pollIntervalMs={pollIntervalMs}
      qrSize={qrSize}
    />
  );
}

function BidirectionalPairingContent({
  syncAccount,
  active,
  qrScanner,
  pendingPairUri,
  onPairUriHandled,
  onPaired,
  pollIntervalMs,
  qrSize,
}: {
  readonly syncAccount: SyncAccountPort;
  readonly active: boolean;
  readonly qrScanner?: QrScannerPort;
  readonly pendingPairUri?: string | null;
  readonly onPairUriHandled?: () => void;
  readonly onPaired?: () => void;
  readonly pollIntervalMs: number;
  readonly qrSize: number;
}): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';
  const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

  const [session, setSession] = useState<BidirectionalPairingSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [errorKey, setErrorKey] = useState<MessageId | null>(null);
  const [cameraNoticeVisible, setCameraNoticeVisible] = useState(false);
  const [hostEpoch, setHostEpoch] = useState(0);

  const mountedRef = useRef(true);
  const syncAccountRef = useRef(syncAccount);
  syncAccountRef.current = syncAccount;
  const sessionRef = useRef<BidirectionalPairingSnapshot | null>(null);
  sessionRef.current = session;
  const sessionOpSeqRef = useRef(0);
  const onPairedRef = useRef(onPaired);
  onPairedRef.current = onPaired;
  const onPairUriHandledRef = useRef(onPairUriHandled);
  onPairUriHandledRef.current = onPairUriHandled;
  const lastHandledUriRef = useRef<string | null>(null);
  const syncedSameAccountRef = useRef<string | null>(null);
  const notifiedCompleteRef = useRef<string | null>(null);

  // Cancel any active non-terminal pairing session on unmount so ephemeral X25519 keys never leak.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const current = sessionRef.current;
      if (current !== null && isNonTerminalStatus(current.status)) {
        sessionRef.current = null;
        cancelPairingBestEffort(syncAccountRef.current, current.pairingId);
      }
    };
  }, []);

  const handleJoin = useCallback(
    async (rawInput: string) => {
      const normalized = normalizePairingInput(rawInput);
      if (normalized === null) {
        setErrorKey('pair.errorInvalidCode');
        return;
      }
      const joinFn = syncAccount.joinBidirectionalPairing;
      if (joinFn === undefined) return;
      const opSeq = ++sessionOpSeqRef.current;
      const priorSession = sessionRef.current;
      if (priorSession !== null && isNonTerminalStatus(priorSession.status)) {
        sessionRef.current = null;
        cancelPairingBestEffort(syncAccount, priorSession.pairingId);
      }
      setErrorKey(null);
      setCameraNoticeVisible(false);
      setBusy(true);
      try {
        // Phase 1 ONLY: key exchange + SAS/masked email preview; never auto-confirm.
        const joined = await joinFn(normalized);
        if (!mountedRef.current || sessionOpSeqRef.current !== opSeq) {
          if (isNonTerminalStatus(joined.status)) {
            cancelPairingBestEffort(syncAccount, joined.pairingId);
          }
          return;
        }
        sessionRef.current = joined;
        setSession(joined);
        setCodeInput('');
      } catch {
        if (mountedRef.current && sessionOpSeqRef.current === opSeq) {
          setErrorKey('account.errorGeneric');
        }
      } finally {
        if (mountedRef.current && sessionOpSeqRef.current === opSeq) {
          setBusy(false);
        }
      }
    },
    [syncAccount],
  );

  // Auto-join incoming elviptv://pair?... or Universal Link URI (Phase 1 only, never auto-confirms)
  useEffect(() => {
    if (!pendingPairUri || pendingPairUri.trim().length === 0) {
      lastHandledUriRef.current = null;
      return;
    }
    if (!active) return;
    const trimmed = pendingPairUri.trim();
    if (lastHandledUriRef.current === trimmed) return;
    lastHandledUriRef.current = trimmed;
    onPairUriHandledRef.current?.();
    void handleJoin(trimmed);
  }, [active, handleJoin, pendingPairUri]);

  // Start hosting a bidirectional pairing session whenever active and no deep link is taking over
  // biome-ignore lint/correctness/useExhaustiveDependencies: hostEpoch explicitly restarts hosting on demand
  useEffect(() => {
    if (!active || (pendingPairUri && pendingPairUri.trim().length > 0)) return undefined;
    const startFn = syncAccount.startBidirectionalPairing;
    if (startFn === undefined) return undefined;
    let alive = true;
    const opSeq = ++sessionOpSeqRef.current;
    setLoading(true);
    setErrorKey(null);
    void startFn()
      .then((created) => {
        if (!alive || !mountedRef.current || sessionOpSeqRef.current !== opSeq) {
          if (isNonTerminalStatus(created.status)) {
            cancelPairingBestEffort(syncAccount, created.pairingId);
          }
          return;
        }
        sessionRef.current = created;
        setSession(created);
      })
      .catch(() => {
        if (alive && mountedRef.current && sessionOpSeqRef.current === opSeq) {
          setErrorKey('account.errorGeneric');
        }
      })
      .finally(() => {
        if (alive && mountedRef.current && sessionOpSeqRef.current === opSeq) {
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [active, hostEpoch, syncAccount]);

  // Poll active pairing session until a terminal state is reached
  const pairingId = session?.pairingId;
  const sessionStatus = session?.status;
  const sessionDirection = session?.direction;
  useEffect(() => {
    if (
      !active ||
      !pairingId ||
      !sessionStatus ||
      !ACTIVE_STATUSES.has(sessionStatus) ||
      sessionDirection === 'same_account' ||
      sessionDirection === 'neither_signed_in'
    ) {
      return undefined;
    }
    const pollFn = syncAccount.pollBidirectionalPairing;
    if (pollFn === undefined) return undefined;

    let alive = true;
    let inFlight = false;
    const timer = setInterval(() => {
      if (!alive || inFlight) return;
      inFlight = true;
      void pollFn(pairingId)
        .then((next) => {
          inFlight = false;
          if (alive && mountedRef.current && sessionRef.current?.pairingId === pairingId) {
            sessionRef.current = next;
            setSession(next);
          }
        })
        .catch(() => {
          inFlight = false;
        });
    }, pollIntervalMs);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [active, pairingId, pollIntervalMs, sessionDirection, sessionStatus, syncAccount]);

  // Same-account instant sync & completion callback (never auto-close on neither_signed_in)
  useEffect(() => {
    if (!session) return;
    if (
      session.direction === 'same_account' &&
      syncedSameAccountRef.current !== session.pairingId
    ) {
      syncedSameAccountRef.current = session.pairingId;
      void syncAccount.syncNow().catch(() => undefined);
    }
    if (
      session.status === 'completed' &&
      session.direction !== 'neither_signed_in' &&
      notifiedCompleteRef.current !== session.pairingId
    ) {
      notifiedCompleteRef.current = session.pairingId;
      onPairedRef.current?.();
    }
  }, [session, syncAccount]);

  const handleConfirm = useCallback(
    async (chosenDirection?: 'host_to_responder' | 'responder_to_host') => {
      if (!session || !syncAccount.confirmBidirectionalPairing) return;
      setBusy(true);
      setErrorKey(null);
      try {
        const res = await syncAccount.confirmBidirectionalPairing(
          session.pairingId,
          chosenDirection,
        );
        if (!mountedRef.current) return;
        if (res.ok) {
          const isLocalReceiverChoice =
            session.direction === 'different_accounts' &&
            ((session.role === 'responder' && chosenDirection === 'host_to_responder') ||
              (session.role === 'host' && chosenDirection === 'responder_to_host'));
          let updated: BidirectionalPairingSnapshot | null = null;
          if (syncAccount.pollBidirectionalPairing) {
            try {
              const polled = await syncAccount.pollBidirectionalPairing(session.pairingId);
              if (!mountedRef.current) return;
              if (polled.pairingId === session.pairingId && polled.status !== 'pending') {
                updated = polled;
              }
            } catch {
              // Fall back to deterministic local transition below; interval poller continues if waiting.
            }
          }
          if (!mountedRef.current) return;
          setSession((prev) => {
            if (!prev || prev.pairingId !== session.pairingId) return prev;
            const next =
              updated ??
              ({
                ...prev,
                status: isLocalReceiverChoice ? 'waiting_approval' : 'completed',
              } as const);
            sessionRef.current = next;
            return next;
          });
        } else {
          setErrorKey(mapSyncErrorCodeToMessageId(res.errorCode));
        }
      } catch {
        if (mountedRef.current) setErrorKey('account.errorGeneric');
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [session, syncAccount],
  );

  const handleCancel = useCallback(async () => {
    const current = sessionRef.current;
    sessionRef.current = null;
    if (current && syncAccount.cancelBidirectionalPairing) {
      try {
        await syncAccount.cancelBidirectionalPairing(current.pairingId);
      } catch {
        // Best-effort cancellation before regenerating host code.
      }
    }
    if (!mountedRef.current) return;
    setSession(null);
    setErrorKey(null);
    setHostEpoch((prev) => prev + 1);
  }, [syncAccount]);

  const handleScanQr = useCallback(async () => {
    setErrorKey(null);
    if (!qrScanner?.isSupported()) {
      setCameraNoticeVisible(true);
      return;
    }
    setCameraNoticeVisible(false);
    setBusy(true);
    try {
      const scanned = await qrScanner.scanQrCode();
      if (scanned && scanned.trim().length > 0) {
        await handleJoin(scanned);
      }
    } catch {
      setCameraNoticeVisible(true);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [handleJoin, qrScanner]);

  const handleRegenerate = useCallback(() => {
    const current = sessionRef.current;
    if (current !== null && isNonTerminalStatus(current.status)) {
      cancelPairingBestEffort(syncAccountRef.current, current.pairingId);
    }
    sessionRef.current = null;
    setSession(null);
    setErrorKey(null);
    setCameraNoticeVisible(false);
    setHostEpoch((prev) => prev + 1);
  }, []);

  if (session !== null) {
    const terminalView = (
      <BidirectionalPairingTerminalView
        session={session}
        isTv={isTv}
        onRegenerate={handleRegenerate}
      />
    );
    if (
      session.direction === 'same_account' ||
      session.direction === 'neither_signed_in' ||
      session.status === 'completed' ||
      session.status === 'expired' ||
      session.status === 'locked' ||
      session.status === 'rejected'
    ) {
      return terminalView;
    }
    const showSasConfirm = shouldShowSasConfirmCard(session);
    const showWaiting = shouldShowWaitingCard(session);
    if (showSasConfirm || showWaiting) {
      return (
        <BidirectionalPairingSasCard
          session={session}
          isWaiting={!showSasConfirm}
          isTv={isTv}
          busy={busy}
          monoFont={monoFont}
          errorKey={errorKey}
          onConfirm={(dir) => {
            void handleConfirm(dir);
          }}
          onCancel={() => {
            void handleCancel();
          }}
        />
      );
    }
  }

  return (
    <View testID="pair-bidirectional-panel" style={styles.block}>
      <View style={styles.headerBlock}>
        <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
          {i18n.t('pair.title')}
        </Text>
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {i18n.t('pair.subtitle')}
        </Text>
      </View>

      {loading && session === null ? (
        <Text
          testID="pair-loading"
          style={[
            theme.typography.caption,
            styles.centerText,
            { color: theme.colors.textSecondary },
          ]}
        >
          {i18n.t('account.syncingStatus')}
        </Text>
      ) : session !== null ? (
        <View style={styles.qrBlock}>
          {session.qrUri !== undefined ? (
            <QrCodeView
              value={session.qrUri}
              size={qrSize}
              testID="pair-qr-code"
              accessibilityLabel={i18n.t('pair.title')}
            />
          ) : null}
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('pair.codeLabel')}
          </Text>
          <Text
            testID="pair-host-code"
            selectable
            style={[
              theme.typography.h2,
              TABULAR_NUMS_STYLE,
              { color: theme.colors.textPrimary, fontFamily: monoFont, letterSpacing: 3 },
            ]}
          >
            {formatPairingCodeDisplay(session.code)}
          </Text>
        </View>
      ) : null}

      <View style={[styles.divider, { backgroundColor: theme.colors.surfaceBorder }]} />

      <AccountTextField
        testID="pair-code-input"
        label={i18n.t('pair.enterCodeLabel')}
        value={codeInput}
        onChangeText={(next) => {
          setCodeInput(formatCodeInputText(next));
          if (errorKey !== null) setErrorKey(null);
        }}
        placeholder={i18n.t('pair.enterCodePlaceholder')}
        editable={!busy}
      />

      {errorKey !== null ? (
        <Text
          testID="pair-error"
          accessibilityLiveRegion="polite"
          style={[theme.typography.caption, { color: theme.colors.liveColor }]}
        >
          {i18n.t(errorKey)}
        </Text>
      ) : null}

      {cameraNoticeVisible ? (
        <Text
          testID="pair-camera-unavailable"
          accessibilityLiveRegion="polite"
          style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
        >
          {i18n.t('pair.cameraUnavailable')}
        </Text>
      ) : null}

      <View style={styles.actionsRow}>
        <CtaButton
          testID="pair-code-submit"
          variant="primary"
          label={i18n.t('pair.connectButton')}
          disabled={busy || codeInput.trim().length === 0}
          onPress={() => {
            void handleJoin(codeInput);
          }}
        />
        <CtaButton
          testID="pair-scan-qr-btn"
          variant="secondary"
          label={i18n.t('pair.scanQrButton')}
          disabled={busy}
          onPress={() => {
            void handleScanQr();
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 12 },
  headerBlock: { gap: 4 },
  qrBlock: { alignItems: 'center', gap: 8, paddingVertical: 4 },
  divider: { height: 1, width: '100%' },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  centerText: { textAlign: 'center' },
});
