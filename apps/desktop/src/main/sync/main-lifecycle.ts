import { arch, release, totalmem } from 'node:os';
import type { DeviceTechnicalProfile } from '@elv/sync';
import type { BrowserWindow, Screen } from 'electron';
import { buildDesktopDeviceProfile, extractSafeErrorSignature } from './device-profile.ts';
import type { DesktopSyncService } from './sync-service.ts';

/** Collects a sanitized {@link DeviceTechnicalProfile} for Electron main process startup (`#509`). */
export function collectDesktopDeviceProfile(deps: {
  readonly screen: Pick<Screen, 'getPrimaryDisplay'>;
  readonly getLocale: () => string;
}): DeviceTechnicalProfile {
  let resolution: string | undefined;
  try {
    const primary = deps.screen.getPrimaryDisplay();
    const w = Math.round(primary.size.width * (primary.scaleFactor || 1));
    const h = Math.round(primary.size.height * (primary.scaleFactor || 1));
    if (w > 0 && h > 0) resolution = `${w}x${h}`;
  } catch {
    resolution = undefined;
  }
  let locale: string | undefined;
  try {
    locale = deps.getLocale();
  } catch {
    locale = undefined;
  }
  return buildDesktopDeviceProfile({
    platform: process.platform,
    arch: arch(),
    totalMemBytes: totalmem(),
    osRelease: release(),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(locale !== undefined ? { locale } : {}),
  });
}

/** Attaches blur/focus/show away-duration tracking to trigger automatic foreground sync pulls (`#510`). */
export function attachWindowSyncLifecycle(
  window: Pick<BrowserWindow, 'on'>,
  getSyncService: () => DesktopSyncService | undefined,
  now: () => number = Date.now,
): void {
  let blurredAt: number | null = null;
  const markAway = (): void => {
    if (blurredAt === null) blurredAt = now();
  };
  const markActive = (): void => {
    if (blurredAt === null) return;
    const awayMs = Math.max(0, now() - blurredAt);
    blurredAt = null;
    getSyncService()?.notifyForeground(awayMs);
  };
  window.on('blur', markAway);
  window.on('hide', markAway);
  window.on('focus', markActive);
  window.on('show', markActive);
  window.on('restore', markActive);
}

/** Registers Node main-process uncaught error telemetry hooks strictly redacted before queueing (`#509`). */
export function attachMainErrorTelemetry(
  getSyncService: () => DesktopSyncService | undefined,
  startedAtMs: number = Date.now(),
): () => void {
  const onUncaught = (error: unknown): void => {
    const sig = extractSafeErrorSignature(error);
    getSyncService()?.recordTelemetry({
      kind: 'app_crash',
      errorName: sig.errorName,
      stackSig: sig.stackSig,
      fatal: false,
      uptimeMs: Math.max(0, Date.now() - startedAtMs),
    });
  };
  const onRejection = (reason: unknown): void => {
    const sig = extractSafeErrorSignature(reason);
    getSyncService()?.recordTelemetry({
      kind: 'unhandled_error',
      errorName: sig.errorName,
      stackSig: sig.stackSig,
      source: 'main',
    });
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
  };
}
