import { redactText } from '@elv/domain';

/**
 * Strict allowlist URL and credential redaction for desktop mpv diagnostics.
 * Delegates to `@elv/domain`'s shared {@link redactText} contract.
 */
export function redactUrls(text: string): string {
  return redactText(text);
}
