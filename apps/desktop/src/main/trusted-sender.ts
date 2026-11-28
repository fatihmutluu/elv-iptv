import { isAllowedDevNavigation } from './dev-server.ts';
import { isAllowedAppNavigation } from './security.ts';

interface SenderFrameLike {
  readonly url?: string;
  readonly top?: unknown;
}

/** Minimal Electron `IpcMainEvent` / `IpcMainInvokeEvent` shape checked for sender-frame trust. */
export interface TrustedSenderEventLike {
  readonly senderFrame?: SenderFrameLike | null;
}

/**
 * Verifies an IPC event originated from a top-level trusted `app://elv` (or optional `devOrigin`)
 * frame. Fails closed when `event.senderFrame` is missing, `null`, detached, or a subframe; never
 * falls back to `event.sender.getURL()`.
 */
export function isTrustedSenderFrame(
  event: TrustedSenderEventLike | null | undefined,
  devOrigin?: string | null,
): boolean {
  if (event === null || event === undefined) return false;
  const frame = event.senderFrame;
  if (frame === null || frame === undefined || typeof frame !== 'object') return false;
  if (frame.top !== frame) return false;
  const url = typeof frame.url === 'string' ? frame.url : '';
  if (url.length === 0) return false;
  if (isAllowedAppNavigation(url)) return true;
  if (devOrigin !== null && devOrigin !== undefined && devOrigin.length > 0) {
    return isAllowedDevNavigation(url, devOrigin);
  }
  return false;
}

/**
 * Enforces {@link isTrustedSenderFrame} for `ipcMain.handle` listeners, logging only the channel
 * name (never URLs or payloads) before throwing an untrusted-sender error.
 */
export function assertTrustedSenderFrame(
  event: TrustedSenderEventLike | null | undefined,
  channel: string,
  devOrigin?: string | null,
  log?: (line: string) => void,
): void {
  if (!isTrustedSenderFrame(event, devOrigin)) {
    log?.(`ipc: rejected untrusted sender on ${channel}`);
    throw new Error(`untrusted sender for ${channel}`);
  }
}
