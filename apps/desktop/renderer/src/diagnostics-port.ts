import { createRingLogBuffer, MAX_CRASH_LOG_LINES, redactText } from '@elv/domain';
import type { DiagnosticsPort } from '@elv/features';
import type { DiagnosticsBridge } from '../../src/shared/diagnostics-ipc.ts';

function detectDesktopPlatformLabel(): string {
  if (typeof navigator === 'undefined') return 'Desktop';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac os') || ua.includes('macintosh')) return 'Desktop (macOS)';
  if (ua.includes('windows')) return 'Desktop (Windows)';
  if (ua.includes('linux')) return 'Desktop (Linux)';
  return 'Desktop';
}

/** Options for {@link createDesktopDiagnosticsPort}. */
export interface DesktopDiagnosticsPortOptions {
  readonly appVersion?: string;
  readonly platformLabel?: string;
  readonly osVersion?: string;
}

/**
 * Adapts the preload's frozen `window.elv.diagnostics` bridge (plus a local redacted ring buffer)
 * into `@elv/features`'s {@link DiagnosticsPort} (`#226`).
 */
export function createDesktopDiagnosticsPort(
  bridge?: DiagnosticsBridge,
  options?: DesktopDiagnosticsPortOptions,
): DiagnosticsPort {
  const ringBuffer = createRingLogBuffer(MAX_CRASH_LOG_LINES);
  const appVersion = options?.appVersion ?? '0.0.0';
  const platformLabel = options?.platformLabel ?? detectDesktopPlatformLabel();

  return {
    appVersion,
    platformLabel,
    ...(options?.osVersion === undefined ? {} : { osVersion: options.osVersion }),
    async readLogTail(maxLines = MAX_CRASH_LOG_LINES): Promise<readonly string[]> {
      const cap =
        Number.isFinite(maxLines) && maxLines >= 1
          ? Math.min(MAX_CRASH_LOG_LINES, Math.floor(maxLines))
          : MAX_CRASH_LOG_LINES;
      const rendererLines = ringBuffer.tail(cap);
      if (!bridge) return rendererLines;
      try {
        const mainLines = await bridge.readLogTail(cap);
        return [...mainLines, ...rendererLines].slice(-cap).map((line) => redactText(line));
      } catch {
        return rendererLines;
      }
    },
    async copyText(text: string): Promise<boolean> {
      const safe = redactText(text);
      if (bridge) {
        try {
          return await bridge.copyReport(safe);
        } catch {
          return false;
        }
      }
      if (
        typeof navigator !== 'undefined' &&
        typeof navigator.clipboard?.writeText === 'function'
      ) {
        try {
          await navigator.clipboard.writeText(safe);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    },
    async exportMarkdown(markdown: string): Promise<boolean> {
      if (!bridge) return false;
      try {
        const reply = await bridge.exportReport(redactText(markdown));
        return reply.saved;
      } catch {
        return false;
      }
    },
    recordDiagnosticLog(line: string): void {
      ringBuffer.push(line, new Date().toISOString());
    },
  };
}
