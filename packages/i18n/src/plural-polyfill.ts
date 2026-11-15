import { PluralRules } from '@formatjs/intl-pluralrules';
import '@formatjs/intl-pluralrules/locale-data/en.js';
import '@formatjs/intl-pluralrules/locale-data/tr.js';

type LocaleDataEntry = Parameters<(typeof PluralRules)['__addLocaleData']>[number];

interface FormatJsGlobal {
  __FORMATJS_PLURALRULES_DATA__?: LocaleDataEntry[];
  Intl?: { PluralRules?: unknown };
}

function drainBundledLocaleData(): void {
  const g = globalThis as unknown as FormatJsGlobal;
  const queued = g.__FORMATJS_PLURALRULES_DATA__;
  if (Array.isArray(queued) && queued.length > 0) {
    PluralRules.__addLocaleData(...queued);
    delete g.__FORMATJS_PLURALRULES_DATA__;
  }
}

drainBundledLocaleData();

function resolveGlobalIntl(): { PluralRules?: unknown } {
  const g = globalThis as unknown as FormatJsGlobal;
  if (typeof g.Intl !== 'object' || g.Intl === null) {
    const created: { PluralRules?: unknown } = {};
    Object.defineProperty(globalThis, 'Intl', {
      value: created,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    return created;
  }
  return g.Intl;
}

/**
 * Installs `@formatjs/intl-pluralrules` (`en` + `tr`) onto `target` (defaulting to `globalThis.Intl`)
 * only when `PluralRules` is missing. Returns `true` when installed, `false` when already present.
 */
export function ensurePluralRules(target?: { PluralRules?: unknown }): boolean {
  const intlTarget = target ?? resolveGlobalIntl();
  if (typeof intlTarget.PluralRules === 'function') {
    return false;
  }
  drainBundledLocaleData();
  Object.defineProperty(intlTarget, 'PluralRules', {
    value: PluralRules,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  return true;
}
