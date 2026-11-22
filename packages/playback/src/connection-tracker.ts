/** Input to {@link ConnectionTracker.checkLimit} before opening a new stream (`#87`). */
export interface ConnectionLimitCheckInput {
  readonly accountKey: string;
  readonly maxConnections: number;
  /** Existing stream ID on the same account that will be closed before opening the new stream (channel zap). */
  readonly replacingStreamId?: string;
  /** Last provider-reported `active_cons` snapshot, if known. */
  readonly providerActiveCons?: number;
}

/** Result of {@link ConnectionTracker.checkLimit}, exposing only known local and provider facts (`#87`). */
export interface ConnectionLimitCheck {
  readonly exceeds: boolean;
  readonly ownActiveCount: number;
  readonly maxConnections: number;
  readonly providerActiveCons?: number;
  readonly canStopOwnStream: boolean;
  readonly stoppableStreamId?: string;
}

/** Per-account tracker of active in-app stream connections (`#87`). */
export interface ConnectionTracker {
  acquire(accountKey: string, streamId: string): void;
  release(streamId: string): void;
  activeCount(accountKey: string): number;
  activeStreamIds(accountKey: string): readonly string[];
  checkLimit(input: ConnectionLimitCheckInput): ConnectionLimitCheck;
}

function normalizeMaxConnections(raw: number): number {
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.floor(raw);
}

function normalizeProviderActiveCons(raw: number | undefined): number | undefined {
  if (raw === undefined || !Number.isFinite(raw) || raw < 0) return undefined;
  return Math.floor(raw);
}

/**
 * Creates a pure in-memory per-`accountKey` connection tracker (`#87`).
 * Replacing an already-held stream on the same account never double-counts so channel zaps
 * never trigger false connection-limit warnings.
 */
export function createConnectionTracker(): ConnectionTracker {
  const streamToAccount = new Map<string, string>();
  const accountToStreams = new Map<string, Set<string>>();

  const removeFromAccount = (accountKey: string, streamId: string): void => {
    const set = accountToStreams.get(accountKey);
    if (set === undefined) return;
    set.delete(streamId);
    if (set.size === 0) accountToStreams.delete(accountKey);
  };

  return {
    acquire(accountKey, streamId) {
      if (accountKey.length === 0 || streamId.length === 0) return;
      const existingAccount = streamToAccount.get(streamId);
      if (existingAccount === accountKey) return;
      if (existingAccount !== undefined) removeFromAccount(existingAccount, streamId);
      let set = accountToStreams.get(accountKey);
      if (set === undefined) {
        set = new Set<string>();
        accountToStreams.set(accountKey, set);
      }
      set.add(streamId);
      streamToAccount.set(streamId, accountKey);
    },

    release(streamId) {
      const existingAccount = streamToAccount.get(streamId);
      if (existingAccount === undefined) return;
      streamToAccount.delete(streamId);
      removeFromAccount(existingAccount, streamId);
    },

    activeCount(accountKey) {
      return accountToStreams.get(accountKey)?.size ?? 0;
    },

    activeStreamIds(accountKey) {
      const set = accountToStreams.get(accountKey);
      return set === undefined ? [] : Array.from(set);
    },

    checkLimit(input) {
      const normalizedMax = normalizeMaxConnections(input.maxConnections);
      const providerActiveCons = normalizeProviderActiveCons(input.providerActiveCons);
      const held = accountToStreams.get(input.accountKey);
      const ownActiveCount = held?.size ?? 0;
      const isReplacingHeld =
        input.replacingStreamId !== undefined && held?.has(input.replacingStreamId) === true;
      const effectiveActive = isReplacingHeld ? ownActiveCount - 1 : ownActiveCount;

      let stoppableStreamId: string | undefined;
      if (held !== undefined) {
        for (const id of held) {
          if (id !== input.replacingStreamId) {
            stoppableStreamId = id;
            break;
          }
        }
      }

      const exceeds =
        effectiveActive >= normalizedMax ||
        (providerActiveCons !== undefined &&
          providerActiveCons >= normalizedMax &&
          !isReplacingHeld);

      return {
        exceeds,
        ownActiveCount,
        maxConnections: normalizedMax,
        ...(providerActiveCons === undefined ? {} : { providerActiveCons }),
        canStopOwnStream: stoppableStreamId !== undefined,
        ...(stoppableStreamId === undefined ? {} : { stoppableStreamId }),
      };
    },
  };
}
