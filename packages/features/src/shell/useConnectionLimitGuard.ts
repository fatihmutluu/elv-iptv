import { normalizeMaxConnections, resolveAccountPoolKey, type SourceRow } from '@elv/data';
import {
  type ConnectionLimitCheck,
  type ConnectionTracker,
  createConnectionTracker,
} from '@elv/playback';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';
import { useStreamHealth } from '../shared';

/** Pending pre-flight connection limit prompt held until the user confirms or cancels (`#87`). */
export interface PendingConnectionPrompt {
  readonly target: PlayTarget;
  readonly accountKey: string;
  readonly check: ConnectionLimitCheck;
}

/** Options for {@link useConnectionLimitGuard}. */
export interface UseConnectionLimitGuardOptions {
  readonly sourcesRef: { readonly current: readonly SourceRow[] };
  readonly enrichTarget: (target: PlayTarget, sources: readonly SourceRow[]) => PlayTarget;
  readonly connectionTracker?: ConnectionTracker;
  readonly onOpenTarget: (target: PlayTarget) => void;
  readonly onReplaceTarget: (target: PlayTarget) => void;
  readonly onStopOtherStream?: (streamId: string) => void;
}

/** Pre-flight connection tracker state and play/zap/exit handlers for `AppShell` (`#87`). */
export interface ConnectionLimitGuard {
  readonly pending: PendingConnectionPrompt | null;
  readonly requestPlay: (target: PlayTarget) => void;
  readonly replaceActiveTarget: (target: PlayTarget) => void;
  readonly releaseActive: () => void;
  readonly handleStopOther: () => void;
  readonly handleCancel: () => void;
  readonly handleContinueAnyway: () => void;
}

function resolveConnectionInfo(
  target: PlayTarget,
  sources: readonly SourceRow[],
  enrichTarget: (target: PlayTarget, sources: readonly SourceRow[]) => PlayTarget,
): {
  enriched: PlayTarget;
  accountKey: string;
  maxConnections: number;
  providerActiveCons?: number;
} {
  const enriched = enrichTarget(target, sources);
  const source = sources.find((s) => s.id === enriched.sourceId);
  const accountKey =
    enriched.accountKey ?? (source ? resolveAccountPoolKey(source) : enriched.sourceId);
  const maxConnections = normalizeMaxConnections(source?.accountMeta?.maxConnections);
  const providerActiveCons = source?.accountMeta?.activeConnections;
  return {
    enriched,
    accountKey,
    maxConnections,
    ...(providerActiveCons !== undefined ? { providerActiveCons } : {}),
  };
}

/**
 * Coordinates per-`accountKey` active stream counting (`ConnectionTracker`) and pre-flight
 * {@link ConnectionLimitDialog} confirmation in `AppShell` (`#87`). Channel zaps pass
 * `replacingStreamId` so single-connection accounts never trigger false warnings.
 */
export function useConnectionLimitGuard({
  sourcesRef,
  enrichTarget,
  connectionTracker,
  onOpenTarget,
  onReplaceTarget,
  onStopOtherStream,
}: UseConnectionLimitGuardOptions): ConnectionLimitGuard {
  const defaultTracker = useMemo(() => createConnectionTracker(), []);
  const tracker = connectionTracker ?? defaultTracker;
  const streamHealth = useStreamHealth();
  const activeStreamIdRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const [pending, setPending] = useState<PendingConnectionPrompt | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  useEffect(() => streamHealth.registerConnectionTracker(tracker), [streamHealth, tracker]);

  const releaseActive = useCallback(() => {
    const currentId = activeStreamIdRef.current;
    if (currentId !== null) {
      tracker.release(currentId);
      activeStreamIdRef.current = null;
    }
    pendingRef.current = null;
    setPending(null);
  }, [tracker]);

  useEffect(() => () => releaseActive(), [releaseActive]);

  const commitPlay = useCallback(
    (target: PlayTarget, accountKey: string, replace = false) => {
      const prevId = activeStreamIdRef.current;
      if (prevId !== null) {
        tracker.release(prevId);
      }
      seqRef.current += 1;
      const nextId = `shell:${seqRef.current}:${target.itemKey}`;
      tracker.acquire(accountKey, nextId);
      activeStreamIdRef.current = nextId;
      if (replace) onReplaceTarget(target);
      else onOpenTarget(target);
    },
    [onOpenTarget, onReplaceTarget, tracker],
  );

  const requestPlay = useCallback(
    (target: PlayTarget) => {
      const info = resolveConnectionInfo(target, sourcesRef.current, enrichTarget);
      const check = tracker.checkLimit({
        accountKey: info.accountKey,
        maxConnections: info.maxConnections,
        ...(activeStreamIdRef.current !== null
          ? { replacingStreamId: activeStreamIdRef.current }
          : {}),
        ...(info.providerActiveCons !== undefined
          ? { providerActiveCons: info.providerActiveCons }
          : {}),
      });
      if (check.exceeds) {
        setPending({ target: info.enriched, accountKey: info.accountKey, check });
        return;
      }
      setPending(null);
      commitPlay(info.enriched, info.accountKey, false);
    },
    [commitPlay, enrichTarget, sourcesRef, tracker],
  );

  const replaceActiveTarget = useCallback(
    (target: PlayTarget) => {
      const info = resolveConnectionInfo(target, sourcesRef.current, enrichTarget);
      tracker.checkLimit({
        accountKey: info.accountKey,
        maxConnections: info.maxConnections,
        ...(activeStreamIdRef.current !== null
          ? { replacingStreamId: activeStreamIdRef.current }
          : {}),
        ...(info.providerActiveCons !== undefined
          ? { providerActiveCons: info.providerActiveCons }
          : {}),
      });
      commitPlay(info.enriched, info.accountKey, true);
    },
    [commitPlay, enrichTarget, sourcesRef, tracker],
  );

  const handleStopOther = useCallback(() => {
    const current = pendingRef.current;
    if (current === null) return;
    pendingRef.current = null;
    setPending(null);
    const stopId = current.check.stoppableStreamId;
    if (stopId !== undefined) {
      tracker.release(stopId);
      onStopOtherStream?.(stopId);
    }
    commitPlay(current.target, current.accountKey, false);
  }, [commitPlay, onStopOtherStream, tracker]);

  const handleCancel = useCallback(() => {
    pendingRef.current = null;
    setPending(null);
  }, []);

  const handleContinueAnyway = useCallback(() => {
    const current = pendingRef.current;
    if (current === null) return;
    pendingRef.current = null;
    setPending(null);
    commitPlay(current.target, current.accountKey, false);
  }, [commitPlay]);

  return {
    pending,
    requestPlay,
    replaceActiveTarget,
    releaseActive,
    handleStopOther,
    handleCancel,
    handleContinueAnyway,
  };
}
