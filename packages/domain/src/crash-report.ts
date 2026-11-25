import { redactText } from './redact';

/** Maximum number of redacted diagnostic log lines retained in a ring buffer or crash report (`#226`). */
export const MAX_CRASH_LOG_LINES = 250;

/** Bounded FIFO ring buffer storing redacted single-line diagnostic log entries (`#226`). */
export interface RingLogBuffer {
  push(line: string, timestampIso?: string): void;
  tail(limit?: number): readonly string[];
  clear(): void;
  size(): number;
}

/** Input payload for building a redacted Markdown diagnostic crash report (`#226`). */
export interface CrashReportInput {
  readonly appVersion: string;
  readonly platform: string;
  readonly osVersion?: string;
  readonly errorCode: string;
  readonly errorMessage?: string;
  readonly componentStack?: string;
  readonly stack?: string;
  readonly includeLogs: boolean;
  readonly logLines?: readonly string[];
  readonly generatedAtIso?: string;
}

function sanitizeLine(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Creates a bounded FIFO ring buffer that redacts every line via {@link redactText} on push
 * and again on snapshot (`tail`), capping retention to `maxLines` (at most {@link MAX_CRASH_LOG_LINES}).
 */
export function createRingLogBuffer(maxLines = MAX_CRASH_LOG_LINES): RingLogBuffer {
  const cap =
    Number.isFinite(maxLines) && maxLines >= 1
      ? Math.min(MAX_CRASH_LOG_LINES, Math.floor(maxLines))
      : MAX_CRASH_LOG_LINES;
  const entries: string[] = [];

  return {
    push(line: string, timestampIso?: string): void {
      const cleaned = sanitizeLine(line);
      if (cleaned.length === 0) return;
      const redactedLine = redactText(cleaned);
      const ts = timestampIso === undefined ? '' : sanitizeLine(timestampIso);
      const entry = ts.length > 0 ? `[${redactText(ts)}] ${redactedLine}` : redactedLine;
      entries.push(entry);
      while (entries.length > cap) {
        entries.shift();
      }
    },

    tail(limit?: number): readonly string[] {
      if (limit === undefined) {
        return entries.map((line) => redactText(line));
      }
      if (!Number.isFinite(limit) || limit <= 0) return [];
      const count = Math.floor(limit);
      return entries.slice(-count).map((line) => redactText(line));
    },

    clear(): void {
      entries.length = 0;
    },

    size(): number {
      return entries.length;
    },
  };
}

/**
 * Generates an English Markdown diagnostic report for opt-in crash recovery (`#226`).
 * Recent logs are included strictly when `input.includeLogs === true` and capped at
 * {@link MAX_CRASH_LOG_LINES}; the entire assembled output is double-redacted via {@link redactText}.
 */
export function buildCrashReportMarkdown(input: CrashReportInput): string {
  const sections: string[] = ['# ELV IPTV Diagnostic Report', ''];

  const meta: string[] = [
    `- **App Version:** ${sanitizeLine(input.appVersion)}`,
    `- **Platform:** ${sanitizeLine(input.platform)}`,
  ];
  if (input.osVersion !== undefined && sanitizeLine(input.osVersion).length > 0) {
    meta.push(`- **OS Version:** ${sanitizeLine(input.osVersion)}`);
  }
  if (input.generatedAtIso !== undefined && sanitizeLine(input.generatedAtIso).length > 0) {
    meta.push(`- **Generated At:** ${sanitizeLine(input.generatedAtIso)}`);
  }
  sections.push(meta.join('\n'), '');

  const errorLines: string[] = [
    '## Error Summary',
    '',
    `- **Code:** \`${sanitizeLine(input.errorCode)}\``,
  ];
  if (input.errorMessage !== undefined && sanitizeLine(input.errorMessage).length > 0) {
    errorLines.push(`- **Message:** ${sanitizeLine(input.errorMessage)}`);
  }
  if (input.stack !== undefined && input.stack.trim().length > 0) {
    errorLines.push('', '```', input.stack.trim(), '```');
  }
  sections.push(errorLines.join('\n'));

  if (input.componentStack !== undefined && input.componentStack.trim().length > 0) {
    sections.push('', '## Component Stack', '', '```', input.componentStack.trim(), '```');
  }

  if (input.includeLogs === true) {
    const recent = (input.logLines ?? [])
      .map((line) => sanitizeLine(line))
      .filter((line) => line.length > 0)
      .slice(-MAX_CRASH_LOG_LINES);
    sections.push('', '## Recent Logs (redacted)', '');
    if (recent.length > 0) {
      sections.push('```', recent.join('\n'), '```');
    } else {
      sections.push('_No recent logs available._');
    }
  }

  return redactText(sections.join('\n'));
}
