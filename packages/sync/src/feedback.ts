import { elvError, err, ok, type Result, redactText } from '@elv/domain';
import type { SyncHttpPort } from './ports';

/** Allowlisted user feedback and issue report categories (`#458`). */
export const FEEDBACK_CATEGORIES = [
  'playback_issue',
  'channel_epg',
  'ui_remote',
  'sync_account',
  'feature_request',
  'other',
] as const;

/** User-selectable feedback category. */
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** Maximum character length permitted for user feedback text. */
export const MAX_FEEDBACK_MESSAGE_CHARS = 2000;

/** Maximum character length permitted for optional redacted diagnostics summary. */
export const MAX_FEEDBACK_DIAGNOSTICS_CHARS = 4000;

/** Structured redacted diagnostics record attached optionally to user feedback. */
export type FeedbackDiagnosticsRecord = Readonly<Record<string, string | number | boolean>>;

/** Structured user feedback payload submitted to `POST /v1/feedback`. */
export interface FeedbackSubmission {
  readonly category: FeedbackCategory;
  readonly message: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly locale?: string;
  readonly diagnostics?: FeedbackDiagnosticsRecord | string;
}

/** Sanitized wire-ready feedback submission where optional diagnostics is always a redacted object. */
export interface SanitizedFeedbackSubmission {
  readonly category: FeedbackCategory;
  readonly message: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly locale?: string;
  readonly diagnostics?: FeedbackDiagnosticsRecord;
}

/** Options for {@link submitFeedback}. */
export interface SubmitFeedbackOptions {
  readonly baseUrl: string;
  readonly http: SyncHttpPort;
  readonly submission: FeedbackSubmission;
  readonly signal?: AbortSignal;
}

/** Returns true when `value` is a supported {@link FeedbackCategory}. */
export function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return typeof value === 'string' && (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

function stripUnsafeControlChars(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f)) {
      out += text.charAt(i);
    }
  }
  return out;
}

function doubleRedactAndClamp(raw: string, maxChars: number): string {
  const cleaned = stripUnsafeControlChars(raw).trim();
  if (cleaned.length === 0) return '';
  const redacted = redactText(redactText(cleaned));
  return redacted.length > maxChars ? redacted.slice(0, maxChars) : redacted;
}

function sanitizeShortMeta(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = stripUnsafeControlChars(value).trim();
  if (cleaned.length === 0) return fallback;
  const redacted = redactText(cleaned);
  return redacted.length > 64 ? redacted.slice(0, 64) : redacted;
}

function sanitizeDiagnostics(
  raw: FeedbackDiagnosticsRecord | string | undefined,
): FeedbackDiagnosticsRecord | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    const summary = doubleRedactAndClamp(raw, MAX_FEEDBACK_DIAGNOSTICS_CHARS);
    return summary.length > 0 ? { summary } : undefined;
  }
  const out: Record<string, string | number | boolean> = {};
  let entries = 0;
  for (const key of Object.keys(raw)) {
    if (entries >= 32) break;
    const safeKey = sanitizeShortMeta(key, '');
    if (safeKey.length === 0 || safeKey === '__proto__') continue;
    const val = raw[key];
    if (typeof val === 'string') {
      const safeVal = doubleRedactAndClamp(val, 512);
      if (safeVal.length > 0) {
        out[safeKey] = safeVal;
        entries += 1;
      }
    } else if (typeof val === 'number' && Number.isFinite(val)) {
      out[safeKey] = val;
      entries += 1;
    } else if (typeof val === 'boolean') {
      out[safeKey] = val;
      entries += 1;
    }
  }
  return entries > 0 ? out : undefined;
}

/**
 * Validates, double-redacts accidental URLs/credentials/tokens via `@elv/domain` `redactText`,
 * and clamps a {@link FeedbackSubmission} (`message <= 2000` chars).
 */
export function sanitizeFeedbackSubmission(
  raw: FeedbackSubmission,
): Result<SanitizedFeedbackSubmission> {
  if (!isFeedbackCategory(raw.category)) {
    return err(elvError('source-format', 'invalid-feedback-category'));
  }
  const message = doubleRedactAndClamp(raw.message, MAX_FEEDBACK_MESSAGE_CHARS);
  if (message.length === 0) {
    return err(elvError('source-format', 'empty-feedback-message'));
  }
  const platform = sanitizeShortMeta(raw.platform, 'unknown');
  const appVersion = sanitizeShortMeta(raw.appVersion, '0.0.0');
  const locale = raw.locale !== undefined ? sanitizeShortMeta(raw.locale, '') : '';
  const diagnostics = sanitizeDiagnostics(raw.diagnostics);

  return ok({
    category: raw.category,
    message,
    platform,
    appVersion,
    ...(locale.length >= 2 ? { locale } : {}),
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  });
}

/** Sanitizes and submits user feedback to `POST /v1/feedback`. */
export async function submitFeedback(
  options: SubmitFeedbackOptions,
): Promise<Result<{ readonly id: string }>> {
  const sanitized = sanitizeFeedbackSubmission(options.submission);
  if (!sanitized.ok) return sanitized;

  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  try {
    const res = await options.http.request({
      method: 'POST',
      url: `${baseUrl}/v1/feedback`,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(sanitized.value),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    if (res.status < 200 || res.status >= 300) {
      return err(elvError('network', `http-${res.status}`));
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      const obj: unknown = JSON.parse(res.bodyText);
      if (typeof obj === 'object' && obj !== null) parsed = obj as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed.id !== 'string' || parsed.id.length === 0) {
      return err(elvError('network', 'invalid-feedback-response'));
    }
    return ok({ id: parsed.id });
  } catch {
    return err(elvError('network', 'feedback-submit-failed'));
  }
}
