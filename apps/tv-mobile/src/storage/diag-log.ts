import { createRingLogBuffer, MAX_CRASH_LOG_LINES, redactText } from '@elv/domain';
import type { DiagnosticsPort } from '@elv/features';
import Constants from 'expo-constants';
import { Platform, Share } from 'react-native';

/** Options for {@link createMobileDiagnosticsPort}. */
export interface CreateMobileDiagnosticsPortOptions {
  readonly appVersion?: string;
  readonly os?: string;
  readonly isTV?: boolean;
  readonly osVersion?: string;
  readonly maxLines?: number;
  readonly shareFn?: (content: { message: string }) => Promise<unknown>;
  readonly copyTextFn?: (text: string) => Promise<boolean>;
}

/**
 * Creates a mobile/TV {@link DiagnosticsPort} (`#226`) backed by a bounded 250-line
 * redacted FIFO ring buffer (`createRingLogBuffer`) and OS share sheet export (`Share.share`).
 */
export function createMobileDiagnosticsPort(
  options: CreateMobileDiagnosticsPortOptions = {},
): DiagnosticsPort {
  const os = options.os ?? Platform.OS;
  const isTV = options.isTV ?? Platform.isTV;
  const appVersion = options.appVersion ?? Constants.expoConfig?.version ?? '0.0.0';
  const osVersion =
    options.osVersion ?? (Platform.Version !== undefined ? String(Platform.Version) : undefined);
  const platformLabel =
    os === 'android'
      ? isTV
        ? 'Android TV'
        : 'Android'
      : os === 'ios'
        ? isTV
          ? 'tvOS'
          : 'iOS'
        : os;

  const buffer = createRingLogBuffer(options.maxLines ?? MAX_CRASH_LOG_LINES);
  const shareFn = options.shareFn ?? ((content: { message: string }) => Share.share(content));
  const supportsShare = !(os === 'ios' && isTV);

  const copyTextFn = options.copyTextFn;

  return {
    appVersion,
    platformLabel,
    ...(osVersion !== undefined ? { osVersion } : {}),
    async readLogTail(maxLines = MAX_CRASH_LOG_LINES): Promise<readonly string[]> {
      return buffer.tail(Math.min(MAX_CRASH_LOG_LINES, Math.max(0, Math.floor(maxLines))));
    },
    ...(copyTextFn !== undefined
      ? {
          async copyText(text: string): Promise<boolean> {
            try {
              return await copyTextFn(redactText(text));
            } catch {
              return false;
            }
          },
        }
      : {}),
    ...(supportsShare
      ? {
          async exportMarkdown(markdown: string): Promise<boolean> {
            try {
              await shareFn({ message: redactText(markdown) });
              return true;
            } catch {
              return false;
            }
          },
        }
      : {}),
    recordDiagnosticLog(line: string): void {
      buffer.push(line, new Date().toISOString());
    },
  };
}
