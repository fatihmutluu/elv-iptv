import type { TrailerExternalPort } from '@elv/features';
import type { WindowBridge } from '../../src/shared/window-ipc.ts';
import { isAllowedExternalTrailerUrl } from '../../src/shared/window-ipc.ts';

/** Validates that a desktop external trailer URL matches the strict HTTPS YouTube allowlist (`#512`). */
export function isAllowedDesktopTrailerUrl(url: string): boolean {
  return isAllowedExternalTrailerUrl(url);
}

/** Creates the desktop {@link TrailerExternalPort} backed by the allowlisted `window:open-external-url` IPC (`#512`). */
export function createDesktopTrailerExternalPort(
  windowBridge?: Pick<WindowBridge, 'openExternalUrl'>,
): TrailerExternalPort {
  return {
    async openExternalUrl(url: string): Promise<boolean> {
      if (!isAllowedDesktopTrailerUrl(url)) return false;
      const openFn = windowBridge?.openExternalUrl;
      if (typeof openFn !== 'function') return false;
      try {
        return (await openFn(url.trim())) === true;
      } catch {
        return false;
      }
    },
  };
}
