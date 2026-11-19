import type { AppI18n } from './i18n';
import type { MessageId } from './locales/en';

const LANGUAGE_MESSAGE_IDS = new Map<string, MessageId>([
  ['tr', 'player.lang.tr'],
  ['tur', 'player.lang.tr'],
  ['en', 'player.lang.en'],
  ['eng', 'player.lang.en'],
  ['de', 'player.lang.de'],
  ['deu', 'player.lang.de'],
  ['ger', 'player.lang.de'],
  ['fr', 'player.lang.fr'],
  ['fra', 'player.lang.fr'],
  ['fre', 'player.lang.fr'],
  ['es', 'player.lang.es'],
  ['spa', 'player.lang.es'],
  ['it', 'player.lang.it'],
  ['ita', 'player.lang.it'],
  ['ru', 'player.lang.ru'],
  ['rus', 'player.lang.ru'],
  ['ar', 'player.lang.ar'],
  ['ara', 'player.lang.ar'],
  ['pt', 'player.lang.pt'],
  ['por', 'player.lang.pt'],
  ['nl', 'player.lang.nl'],
  ['nld', 'player.lang.nl'],
  ['dut', 'player.lang.nl'],
  ['ja', 'player.lang.ja'],
  ['jpn', 'player.lang.ja'],
  ['ko', 'player.lang.ko'],
  ['kor', 'player.lang.ko'],
  ['zh', 'player.lang.zh'],
  ['zho', 'player.lang.zh'],
  ['chi', 'player.lang.zh'],
]);

const UNDETERMINED_CODES = new Set(['und', 'mul', 'mis', 'zxx', 'unknown']);

/**
 * Resolves an ISO 639-1/639-2 language tag to its localized display name, `undefined` when empty
 * or undetermined (`und`), or an uppercase primary subtag fallback for uncommon codes.
 */
export function resolveLanguageLabel(
  code: string | undefined,
  i18n: Pick<AppI18n, 't'>,
): string | undefined {
  if (typeof code !== 'string') return undefined;
  const trimmed = code.trim();
  if (trimmed.length === 0) return undefined;
  const primary = trimmed.split(/[-_]/)[0]?.toLowerCase() ?? '';
  if (primary.length === 0 || UNDETERMINED_CODES.has(primary)) return undefined;
  const messageId = LANGUAGE_MESSAGE_IDS.get(primary);
  return messageId !== undefined ? i18n.t(messageId) : primary.toUpperCase();
}
