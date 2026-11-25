import type { MessageId } from '@elv/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SyncAccountPort,
  SyncAccountState,
  SyncQrPairingSession,
} from '../ports/wave-f9-ports';

/** Minimum password length enforced during sync account registration (`#26`). */
export const MIN_SYNC_PASSWORD_LENGTH = 10;

/** Polling interval (ms) for checking universal QR device pairing completion (`#26`). */
export const QR_POLL_INTERVAL_MS = 2_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Signed-out fallback snapshot used when no {@link SyncAccountPort} is wired. */
export const SIGNED_OUT_SYNC_STATE: SyncAccountState = Object.freeze({
  status: 'signed_out',
  email: null,
  lastSyncedAtIso: null,
  pendingRecoveryCode: null,
  errorCode: null,
});

/** Validates email and password fields for Sign In. Returns a localized error key or `null`. */
export function validateSignInFields(email: string, password: string): MessageId | null {
  if (!EMAIL_RE.test(email.trim())) return 'account.errorInvalidEmail';
  if (password.length === 0) return 'account.errorWeakPassword';
  return null;
}

/** Validates email, password (>= 10 chars), and confirm password for Create Account. */
export function validateSignUpFields(
  email: string,
  password: string,
  confirmPassword: string,
): MessageId | null {
  if (!EMAIL_RE.test(email.trim())) return 'account.errorInvalidEmail';
  if (password.length < MIN_SYNC_PASSWORD_LENGTH) return 'account.errorWeakPassword';
  if (password !== confirmPassword) return 'account.errorPasswordMismatch';
  return null;
}

/** Maps a sync port error code to its user-facing localized message key. */
export function mapSyncErrorCodeToMessageId(errorCode: string | null | undefined): MessageId {
  if (!errorCode) return 'account.errorGeneric';
  const normalized = errorCode.toLowerCase();
  if (normalized === 'invalid_email' || normalized === 'invalid-email') {
    return 'account.errorInvalidEmail';
  }
  if (normalized === 'weak_password' || normalized === 'weak-password') {
    return 'account.errorWeakPassword';
  }
  if (normalized === 'password_mismatch' || normalized === 'password-mismatch') {
    return 'account.errorPasswordMismatch';
  }
  if (normalized === 'pairing_expired' || normalized === 'expired') {
    return 'account.qrExpired';
  }
  return 'account.errorGeneric';
}

/** Subscribes to live {@link SyncAccountState} updates from an optional {@link SyncAccountPort}. */
export function useSyncAccountState(syncAccount?: SyncAccountPort): SyncAccountState {
  const [state, setState] = useState<SyncAccountState>(() =>
    syncAccount ? syncAccount.getState() : SIGNED_OUT_SYNC_STATE,
  );

  useEffect(() => {
    if (!syncAccount) {
      setState(SIGNED_OUT_SYNC_STATE);
      return undefined;
    }
    setState(syncAccount.getState());
    return syncAccount.subscribe((next) => {
      setState(next);
    });
  }, [syncAccount]);

  return state;
}

/** Lifecycle state of an active universal QR pairing session (`#26`). */
export interface SyncQrPairingState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'claimed' | 'expired' | 'error';
  readonly session: SyncQrPairingSession | null;
  readonly regenerate: () => void;
}

/**
 * Starts a universal QR pairing session when `active` is true, polls cleanly on an interval
 * until `'claimed'` or `'expired'`, and tears down timers safely on unmount or deactivation.
 */
export function useSyncQrPairing(
  syncAccount: SyncAccountPort | undefined,
  active: boolean,
  onClaimed?: () => void,
  pollIntervalMs = QR_POLL_INTERVAL_MS,
): SyncQrPairingState {
  const [phase, setPhase] = useState<SyncQrPairingState['phase']>('idle');
  const [session, setSession] = useState<SyncQrPairingSession | null>(null);
  const [epoch, setEpoch] = useState(0);
  const onClaimedRef = useRef(onClaimed);
  onClaimedRef.current = onClaimed;

  const regenerate = useCallback(() => {
    setEpoch((prev) => prev + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch restarts a fresh pairing session on demand
  useEffect(() => {
    if (!active || !syncAccount) {
      setPhase('idle');
      setSession(null);
      return undefined;
    }

    let alive = true;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let pollInFlight = false;

    const clearPoll = () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    setPhase('loading');
    setSession(null);

    void syncAccount
      .createQrPairing()
      .then((created) => {
        if (!alive) return;
        setSession(created);
        if (created.status === 'expired') {
          setPhase('expired');
          return;
        }
        if (created.status === 'claimed') {
          setPhase('claimed');
          onClaimedRef.current?.();
          return;
        }
        setPhase('ready');

        const pollOnce = () => {
          if (!alive || pollInFlight) return;
          if (Date.now() >= created.expiresAtMs) {
            clearPoll();
            setPhase('expired');
            return;
          }
          pollInFlight = true;
          void syncAccount
            .pollQrPairing(created.pairingId)
            .then((status) => {
              pollInFlight = false;
              if (!alive) return;
              if (status === 'claimed') {
                clearPoll();
                setPhase('claimed');
                onClaimedRef.current?.();
              } else if (status === 'expired') {
                clearPoll();
                setPhase('expired');
              }
            })
            .catch(() => {
              pollInFlight = false;
            });
        };

        pollTimer = setInterval(pollOnce, pollIntervalMs);
      })
      .catch(() => {
        if (alive) setPhase('error');
      });

    return () => {
      alive = false;
      clearPoll();
    };
  }, [active, epoch, pollIntervalMs, syncAccount]);

  return { phase, session, regenerate };
}
