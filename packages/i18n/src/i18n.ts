import { type Messages, setupI18n } from '@lingui/core';
import { enMessages, type MessageId } from './locales/en';
import { trMessages } from './locales/tr';
import { ensurePluralRules } from './plural-polyfill';

/** Supported application locales. */
export const SUPPORTED_LOCALES = ['en', 'tr'] as const;

/** Supported locale code (`'en'` or `'tr'`). */
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

/** Pure, React-free localization handle consumed by UI layers and controllers. */
export interface AppI18n {
  readonly locale: AppLocale;
  setLocale(locale: AppLocale): void;
  t(id: MessageId, values?: Record<string, string | number>): string;
  subscribe(listener: () => void): () => void;
}

type CompiledToken = string | [string] | [string, string, Record<string, CompiledToken[]>];

function pushLiteral(out: CompiledToken[], literal: string, splitHash: boolean): void {
  if (literal === '') return;
  if (!splitHash || !literal.includes('#')) {
    out.push(literal);
    return;
  }
  const parts = literal.split('#');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part !== undefined && part !== '') out.push(part);
    if (i < parts.length - 1) out.push('#');
  }
}

function parseBranches(raw: string, splitHash: boolean): Record<string, CompiledToken[]> {
  const branches: Record<string, CompiledToken[]> = {};
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i] ?? '')) i++;
    if (i >= raw.length) break;
    const keyStart = i;
    while (i < raw.length && raw[i] !== '{' && !/\s/.test(raw[i] ?? '')) i++;
    const key = raw.slice(keyStart, i).trim();
    while (i < raw.length && /\s/.test(raw[i] ?? '')) i++;
    if (raw[i] !== '{') break;
    let depth = 1;
    i++;
    const bodyStart = i;
    while (i < raw.length && depth > 0) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') depth--;
      i++;
    }
    const body = raw.slice(bodyStart, i - 1);
    branches[key] = compileIcuMessage(body, splitHash);
  }
  return branches;
}

/** Compiles an ICU message into Lingui's runtime token array so production builds need no runtime compiler. */
function compileIcuMessage(template: string, splitHash = false): CompiledToken[] {
  const tokens: CompiledToken[] = [];
  let cursor = 0;
  let i = 0;
  while (i < template.length) {
    if (template[i] !== '{') {
      i++;
      continue;
    }
    pushLiteral(tokens, template.slice(cursor, i), splitHash);
    let depth = 1;
    i++;
    const exprStart = i;
    while (i < template.length && depth > 0) {
      if (template[i] === '{') depth++;
      else if (template[i] === '}') depth--;
      i++;
    }
    const expr = template.slice(exprStart, i - 1);
    const firstComma = expr.indexOf(',');
    if (firstComma < 0) {
      tokens.push([expr.trim()]);
    } else {
      const name = expr.slice(0, firstComma).trim();
      const afterName = expr.slice(firstComma + 1).trim();
      const secondComma = afterName.indexOf(',');
      if (secondComma < 0) {
        tokens.push([name, afterName, {}]);
      } else {
        const type = afterName.slice(0, secondComma).trim();
        const body = afterName.slice(secondComma + 1);
        tokens.push([
          name,
          type,
          parseBranches(body, type === 'plural' || type === 'selectordinal'),
        ]);
      }
    }
    cursor = i;
  }
  pushLiteral(tokens, template.slice(cursor), splitHash);
  return tokens;
}

function compileCatalog(raw: Readonly<Record<string, string>>): Messages {
  const compiled: Record<string, unknown> = {};
  for (const [id, text] of Object.entries(raw)) {
    compiled[id] = compileIcuMessage(text);
  }
  return compiled as Messages;
}

const COMPILED_CATALOGS: Readonly<Record<AppLocale, Messages>> = {
  en: compileCatalog(enMessages),
  tr: compileCatalog(trMessages),
};

/**
 * Selects the first supported locale from ordered BCP 47 / POSIX language tags
 * (for example `['tr-TR', 'en-US']` or `['tr_CY']`), falling back to `'en'`.
 */
export function resolveLocale(candidates: readonly (string | null | undefined)[]): AppLocale {
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const primary = raw.trim().split(/[-_]/)[0]?.toLowerCase();
    if (primary === 'tr') return 'tr';
    if (primary === 'en') return 'en';
  }
  return 'en';
}

/** Creates an isolated, reactive `@lingui/core`-backed localization instance. */
export function createAppI18n(initialLocale: AppLocale = 'en'): AppI18n {
  ensurePluralRules();
  let currentLocale: AppLocale = initialLocale;
  const lingui = setupI18n({
    locale: initialLocale,
    messages: {
      en: COMPILED_CATALOGS.en,
      tr: COMPILED_CATALOGS.tr,
    },
  });
  const listeners = new Set<() => void>();

  return {
    get locale() {
      return currentLocale;
    },
    setLocale(next: AppLocale) {
      if (next === currentLocale) return;
      currentLocale = next;
      lingui.activate(next);
      for (const listener of [...listeners]) {
        if (listeners.has(listener)) listener();
      }
    },
    t(id: MessageId, values?: Record<string, string | number>) {
      return values === undefined ? lingui._(id) : lingui._(id, values);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
