import { describe, expect, it, vi } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import {
  createAppI18n,
  enMessages,
  ensurePluralRules,
  type MessageId,
  resolveLocale,
  SUPPORTED_LOCALES,
  trMessages,
} from './index';

/** Parses standard gettext `msgid` / `msgstr` pairs (including multi-line string continuations). */
function parsePoCatalog(raw: string): Record<string, string> {
  const entries: Record<string, string> = {};
  let currentKey: 'msgid' | 'msgstr' | null = null;
  let msgid = '';
  let msgstr = '';

  const flush = () => {
    if (msgid !== '') {
      entries[msgid] = msgstr;
    }
    msgid = '';
    msgstr = '';
    currentKey = null;
  };

  const unescapePo = (quoted: string): string => JSON.parse(quoted) as string;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      if (line === '') flush();
      continue;
    }
    if (line.startsWith('msgid ')) {
      flush();
      currentKey = 'msgid';
      msgid += unescapePo(line.slice('msgid '.length).trim());
    } else if (line.startsWith('msgstr ')) {
      currentKey = 'msgstr';
      msgstr += unescapePo(line.slice('msgstr '.length).trim());
    } else if (line.startsWith('"') && currentKey !== null) {
      if (currentKey === 'msgid') msgid += unescapePo(line);
      else msgstr += unescapePo(line);
    }
  }
  flush();
  return entries;
}

/** Extracts top-level ICU `{name}` and `{name, ...}` placeholder variable names from a message. */
function extractPlaceholders(template: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  let tokenStart = -1;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === '{') {
      if (depth === 0) tokenStart = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && tokenStart >= 0) {
        const inner = template.slice(tokenStart, i);
        const name = inner.split(',')[0]?.trim();
        if (name) names.add(name);
        tokenStart = -1;
      }
    }
  }
  return [...names].sort();
}

describe('@elv/i18n', () => {
  it('exposes English and Turkish as supported locales', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'tr']);
  });

  it('resolves device language tags in priority order with fallback to English', () => {
    expect(resolveLocale(['tr-TR', 'en-US'])).toBe('tr');
    expect(resolveLocale(['de-DE', 'tr_CY'])).toBe('tr');
    expect(resolveLocale(['TR-tr'])).toBe('tr');
    expect(resolveLocale(['en-GB'])).toBe('en');
    expect(resolveLocale(['fr-FR'])).toBe('en');
    expect(resolveLocale([undefined, null, '', '  ', '---'])).toBe('en');
    expect(resolveLocale([])).toBe('en');
  });

  it('keeps en and tr catalogs in strict key, placeholder, non-empty, and .po parity', () => {
    const enKeys = Object.keys(enMessages).sort();
    const trKeys = Object.keys(trMessages).sort();
    expect(enKeys.length).toBeGreaterThan(30);
    expect(trKeys).toEqual(enKeys);

    for (const key of enKeys as MessageId[]) {
      expect(enMessages[key].trim().length, `blank en key: ${key}`).toBeGreaterThan(0);
      expect(trMessages[key].trim().length, `blank tr key: ${key}`).toBeGreaterThan(0);
      expect(extractPlaceholders(trMessages[key]), `placeholder mismatch on key: ${key}`).toEqual(
        extractPlaceholders(enMessages[key]),
      );
    }

    expect(parsePoCatalog(enPo)).toEqual(enMessages);
    expect(parsePoCatalog(trPo)).toEqual(trMessages);
  });

  it('preserves Turkish UTF-8 characters and notifies subscribers on locale switch', () => {
    const i18n = createAppI18n('en');
    expect(i18n.locale).toBe('en');
    expect(i18n.t('sources.title')).toBe('Sources');

    const listener = vi.fn();
    const unsubscribe = i18n.subscribe(listener);

    i18n.setLocale('en');
    expect(listener).not.toHaveBeenCalled();

    i18n.setLocale('tr');
    expect(i18n.locale).toBe('tr');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(i18n.t('sources.title')).toBe('Kaynaklar');

    const allTurkishText = (Object.keys(trMessages) as MessageId[])
      .map((id) => trMessages[id])
      .join(' ');
    for (const ch of ['İ', 'ı', 'ş', 'ğ', 'ü', 'ö', 'ç']) {
      expect(allTurkishText).toContain(ch);
    }

    unsubscribe();
    i18n.setLocale('en');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('formats ICU placeholders and plurals in both development and production without warnings', () => {
    const runtime = globalThis as unknown as {
      console: { warn: (...args: unknown[]) => void };
      process: { env: Record<string, string | undefined> };
    };
    const warnSpy = vi.spyOn(runtime.console, 'warn').mockImplementation(() => {});
    const prevNodeEnv = runtime.process.env.NODE_ENV;
    runtime.process.env.NODE_ENV = 'production';
    try {
      const i18n = createAppI18n('en');
      expect(
        i18n.t('sources.status.importingTotal', { phase: 'movies', done: 12, total: 50 }),
      ).toBe('Importing movies (12/50)');
      expect(i18n.t('sources.status.readyCounts', { live: 1, movies: 2, series: 0 })).toBe(
        '1 live channel, 2 movies, 0 series',
      );

      i18n.setLocale('tr');
      expect(
        i18n.t('sources.status.importingTotal', { phase: 'filmler', done: 12, total: 50 }),
      ).toBe('filmler içe aktarılıyor (12/50)');
      expect(i18n.t('sources.status.readyCounts', { live: 3, movies: 1, series: 4 })).toBe(
        '3 canlı kanal, 1 film, 4 dizi',
      );
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      runtime.process.env.NODE_ENV = prevNodeEnv;
      warnSpy.mockRestore();
    }
  });

  it('formats navigation, browse, series, player, and notices strings in English and Turkish', () => {
    const en = createAppI18n('en');
    expect(en.t('nav.live')).toBe('Live');
    expect(en.t('nav.movies')).toBe('Movies');
    expect(en.t('nav.series')).toBe('Series');
    expect(en.t('nav.sources')).toBe('Sources');
    expect(en.t('nav.notices')).toBe('Notices');
    expect(en.t('notices.title')).toBe('Third-party software notices');
    expect(en.t('notices.lgplSummary')).toContain('LGPL');
    expect(en.t('notices.version')).toBe('Version');
    expect(en.t('notices.license')).toBe('License');
    expect(en.t('notices.platforms')).toBe('Platforms');
    expect(en.t('notices.source')).toBe('Source');
    expect(en.t('notices.unmodified')).toContain('Unmodified');
    expect(en.t('notices.backToList')).toBe('Back to notices');
    expect(en.t('browse.categoryCount', { name: 'General', count: 25000 })).toBe('General (25000)');
    expect(en.t('series.seasonCount', { season: 2, count: 8 })).toBe('Season 2 (8)');
    expect(en.t('series.episodeTitled', { episode: 1, title: 'Pilot' })).toBe('E1 · Pilot');
    expect(en.t('series.episodeUntitled', { episode: 3 })).toBe('Episode 3');
    expect(en.t('player.status.recovering', { rung: 2 })).toBe('Reconnecting (step 2)…');
    expect(en.t('player.hint.connectionLimit')).toContain('Retry');

    const tr = createAppI18n('tr');
    expect(tr.t('nav.live')).toBe('Canlı');
    expect(tr.t('nav.movies')).toBe('Filmler');
    expect(tr.t('nav.series')).toBe('Diziler');
    expect(tr.t('nav.sources')).toBe('Kaynaklar');
    expect(tr.t('nav.notices')).toBe('Lisanslar');
    expect(tr.t('notices.title')).toBe('Üçüncü taraf yazılım bildirimleri');
    expect(tr.t('notices.lgplSummary')).toContain('LGPL');
    expect(tr.t('notices.version')).toBe('Sürüm');
    expect(tr.t('notices.license')).toBe('Lisans');
    expect(tr.t('notices.platforms')).toBe('Platformlar');
    expect(tr.t('notices.source')).toBe('Kaynak');
    expect(tr.t('notices.unmodified')).toContain('Değiştirilmemiş');
    expect(tr.t('notices.backToList')).toBe('Bildirimlere dön');
    expect(tr.t('browse.categoryCount', { name: 'Genel', count: 42 })).toBe('Genel (42)');
    expect(tr.t('series.seasonCount', { season: 2, count: 8 })).toBe('2. Sezon (8)');
    expect(tr.t('series.episodeTitled', { episode: 1, title: 'Başlangıç' })).toBe('B1 · Başlangıç');
    expect(tr.t('series.episodeUntitled', { episode: 3 })).toBe('3. Bölüm');
    expect(tr.t('player.status.recovering', { rung: 2 })).toBe('Yeniden bağlanılıyor (adım 2)…');
    expect(tr.t('player.hint.connectionLimit')).toContain('Tekrar dene');
  });

  it('installs Intl.PluralRules polyfill only when missing on the target', () => {
    const missingTarget: { PluralRules?: unknown } = {};
    expect(ensurePluralRules(missingTarget)).toBe(true);
    expect(typeof missingTarget.PluralRules).toBe('function');

    const Ctor = missingTarget.PluralRules as typeof Intl.PluralRules;
    expect(new Ctor('en').select(1)).toBe('one');
    expect(new Ctor('en').select(2)).toBe('other');
    expect(new Ctor('tr').select(1)).toBe('one');
    expect(new Ctor('tr').select(5)).toBe('other');

    expect(ensurePluralRules(missingTarget)).toBe(false);
    expect(ensurePluralRules()).toBe(false);
  });
});
