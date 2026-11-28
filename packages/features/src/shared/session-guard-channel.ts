/** BroadcastChannel name used for cross-window session teardown notifications. */
export const SESSION_GUARD_CHANNEL = 'elv-session-guard';
/** Storage-event fallback key used when BroadcastChannel is unavailable. */
export const SESSION_GUARD_STORAGE_KEY = 'elv:session-guard';

/** Cross-window session teardown notification carrying zero credentials or stream URLs. */
export type SessionGuardEvent =
  | { readonly type: 'parental-relock'; readonly profileId?: string }
  | { readonly type: 'profile-switch'; readonly profileId?: string }
  | { readonly type: 'source-deleted'; readonly sourceId: string };

interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
}

interface BroadcastChannelCtorLike {
  new (name: string): BroadcastChannelLike;
}

interface StorageLike {
  setItem(key: string, value: string): void;
}

/**
 * Broadcasts a minimal cross-window session guard notification (`BroadcastChannel` primary,
 * `localStorage` storage-event fallback) so detached windows (such as Desktop Popout) tear down
 * immediately on parental relock, profile switch, or source deletion.
 */
export function broadcastSessionGuardEvent(event: SessionGuardEvent): void {
  const host = globalThis as unknown as {
    BroadcastChannel?: BroadcastChannelCtorLike;
    localStorage?: StorageLike;
  };
  if (typeof host.BroadcastChannel === 'function') {
    try {
      const channel = new host.BroadcastChannel(SESSION_GUARD_CHANNEL);
      try {
        channel.postMessage(event);
      } finally {
        channel.close();
      }
      return;
    } catch {
      // Fall through to localStorage fallback when BroadcastChannel is unavailable in this host.
    }
  }
  if (host.localStorage && typeof host.localStorage.setItem === 'function') {
    try {
      host.localStorage.setItem(
        SESSION_GUARD_STORAGE_KEY,
        JSON.stringify({ ...event, ts: Date.now(), nonce: Math.random().toString(36).slice(2) }),
      );
    } catch {
      // Ignore storage quota or private-mode restrictions.
    }
  }
}
