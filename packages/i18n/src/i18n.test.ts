import { describe, expect, it, vi } from 'vitest';
import enPo from '../locales/en/messages.po?raw';
import trPo from '../locales/tr/messages.po?raw';
import {
  createAppI18n,
  enMessages,
  ensurePluralRules,
  type MessageId,
  resolveLanguageLabel,
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

  it('localizes settings, appearance, theme presets, and about strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['nav.settings', 'Settings', 'Ayarlar'],
      ['settings.title', 'Settings', 'Ayarlar'],
      [
        'settings.subtitle',
        'Customize appearance, manage sources, and view open-source licenses.',
        'Görünümü özelleştirin, kaynakları yönetin ve açık kaynak lisanslarını inceleyin.',
      ],
      ['settings.section.appearance', 'Appearance', 'Görünüm'],
      ['settings.section.sources', 'Sources', 'Kaynaklar'],
      ['settings.section.licenses', 'About & Licenses', 'Hakkında ve Lisanslar'],
      ['settings.language.label', 'Language', 'Dil'],
      [
        'settings.language.description',
        'Applies immediately across all screens without restarting.',
        'Yeniden başlatmadan tüm ekranlarda anında uygulanır.',
      ],
      ['settings.language.system', 'System', 'Sistem'],
      ['settings.language.tr', 'Türkçe', 'Türkçe'],
      ['settings.language.en', 'English', 'English'],
      ['settings.theme.label', 'Theme', 'Tema'],
      [
        'settings.theme.description',
        'Dynamic Cinema Quietude palettes including WCAG AAA High Contrast.',
        'WCAG AAA Yüksek Kontrast dahil dinamik Cinema Quietude paletleri.',
      ],
      ['settings.theme.obsidianCrimson.label', 'Obsidian Crimson', 'Obsidyen Kızıl'],
      [
        'settings.theme.obsidianCrimson.desc',
        'Pure cinema black with crimson accents',
        'Saf sinema siyahı ve kızıl vurgular',
      ],
      ['settings.theme.abyssalSapphire.label', 'Abyssal Sapphire', 'Derin Safir'],
      [
        'settings.theme.abyssalSapphire.desc',
        'Midnight theater canvas with crisp sapphire',
        'Gece yarısı tonları ve net safir vurgu',
      ],
      ['settings.theme.theaterAmber.label', 'Theater Amber', 'Sinema Kehribar'],
      [
        'settings.theme.theaterAmber.desc',
        'Warm tungsten dark with amber highlight',
        'Sıcak tungsten koyu ve kehribar vurgu',
      ],
      ['settings.theme.velvetViolet.label', 'Velvet Violet', 'Kadife Mor'],
      [
        'settings.theme.velvetViolet.desc',
        'Low-key slate plum with orchid signal',
        'Koyu mürdüm ve zarif orkide vurgusu',
      ],
      ['settings.theme.pitchEmerald.label', 'Pitch Emerald', 'Zümrüt Yeşil'],
      [
        'settings.theme.pitchEmerald.desc',
        'Carbon pitch dark with broadcast emerald',
        'Karbon koyusu ve yayın zümrüt vurgusu',
      ],
      ['settings.theme.highContrast.label', 'High Contrast (AAA)', 'Yüksek Kontrast (AAA)'],
      [
        'settings.theme.highContrast.desc',
        'Pure black with WCAG AAA text and focus contrast',
        'Saf siyah ve WCAG AAA metin/odak kontrastı',
      ],
      ['settings.fontScale.label', 'Text size', 'Yazı boyutu'],
      [
        'settings.fontScale.description',
        'Scales interface typography comfortably from 90% to 120%.',
        'Arayüz yazı boyutunu %90 ile %120 arasında ölçekler.',
      ],
      ['settings.reduceMotion.label', 'Reduce motion', 'Hareketi azalt'],
      [
        'settings.reduceMotion.description',
        'Disables focus zoom and interface transitions.',
        'Odak yakınlaştırmasını ve arayüz geçişlerini kapatır.',
      ],
      ['settings.reset', 'Reset appearance to defaults', 'Görünümü varsayılana sıfırla'],
      ['settings.about.title', 'About ELV IPTV', 'ELV IPTV Hakkında'],
      [
        'settings.about.licenseBadge',
        'GPL-3.0-only · LGPL media engines',
        'GPL-3.0-only · LGPL medya motorları',
      ],
      [
        'settings.about.statement',
        'ELV IPTV is an open-source player and ships no media content. Native playback engines dynamically link LGPL libraries. Provider credentials remain encrypted on-device and never enter the catalog database.',
        'ELV IPTV açık kaynaklı bir oynatıcıdır ve içerik sunmaz. Yerel oynatma motorları LGPL kütüphanelerini dinamik olarak bağlar. Sağlayıcı bilgileri cihazda şifreli saklanır ve katalog veritabanına yazılmaz.',
      ],
    ];
    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }
  });

  it('localizes home, navigation, watch progress, and My List strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['nav.home', 'Home', 'Ana Sayfa'],
      ['home.title', 'Home', 'Ana Sayfa'],
      ['home.continueWatching', 'Continue watching', 'İzlemeye devam et'],
      ['home.onAirNow', 'On air now', 'Şu an yayında'],
      ['home.myList', 'My list', 'Listem'],
      ['home.featuredMovies', 'Featured movies', 'Öne çıkan filmler'],
      ['home.featuredSeries', 'Featured series', 'Öne çıkan diziler'],
      ['home.seeAll', 'See all', 'Tümü'],
      ['home.channels', 'Channels', 'Kanallar'],
      ['home.resume', 'Resume', 'Devam et'],
      ['home.watchNow', 'Play', 'Oynat'],
      ['home.addToList', 'Add to My list', 'Listeme ekle'],
      ['home.inMyList', 'In My list', 'Listemde'],
      ['home.markWatched', 'Mark watched', 'İzlendi işaretle'],
      ['home.markUnwatched', 'Mark unwatched', 'İzlenmedi işaretle'],
      ['home.watchedBadge', 'Watched', 'İzlendi'],
      ['home.featuredTag', 'Featured', 'Öne çıkan'],
      ['home.emptyTitle', 'Your screening room is ready', 'İzleme odanız hazır'],
      [
        'home.emptyDescription',
        'Add an Xtream or M3U source to populate Live TV, Movies, and Series.',
        'Canlı TV, Film ve Dizileri görmek için bir Xtream veya M3U kaynağı ekleyin.',
      ],
      ['home.addSource', 'Manage sources', 'Kaynakları yönet'],
      ['home.kind.live', 'Live TV', 'Canlı TV'],
      ['home.kind.movie', 'Movie', 'Film'],
      ['home.kind.series', 'Series', 'Dizi'],
      ['home.kind.episode', 'Episode', 'Bölüm'],
    ];
    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('home.remainingMin', { minutes: 42 })).toBe('42m left');
    expect(tr.t('home.remainingMin', { minutes: 42 })).toBe('42 dk kaldı');
    expect(en.t('home.heroSlideLabel', { index: 2, total: 5 })).toBe('Spotlight 2 of 5');
    expect(tr.t('home.heroSlideLabel', { index: 2, total: 5 })).toBe('Öne çıkan 2 / 5');
  });

  it('localizes VOD transport controls, track picker strings, and common track language codes', () => {
    const en = createAppI18n('en');
    expect(en.t('player.play')).toBe('Play');
    expect(en.t('player.pause')).toBe('Pause');
    expect(en.t('player.seekBack')).toBe('-10s');
    expect(en.t('player.seekForward')).toBe('+10s');
    expect(en.t('player.tracks')).toBe('Audio & Subtitles');
    expect(en.t('player.audioTracks')).toBe('Audio');
    expect(en.t('player.subtitleTracks')).toBe('Subtitles');
    expect(en.t('player.subtitlesOff')).toBe('Off');
    expect(en.t('player.closeTracks')).toBe('Close');
    expect(en.t('player.trackNumber', { number: 2 })).toBe('Track 2');

    expect(resolveLanguageLabel('tur', en)).toBe('Turkish');
    expect(resolveLanguageLabel('tr-TR', en)).toBe('Turkish');
    expect(resolveLanguageLabel('eng', en)).toBe('English');
    expect(resolveLanguageLabel('en_US', en)).toBe('English');
    expect(resolveLanguageLabel('deu', en)).toBe('German');
    expect(resolveLanguageLabel('ger', en)).toBe('German');
    expect(resolveLanguageLabel('fra', en)).toBe('French');
    expect(resolveLanguageLabel('spa', en)).toBe('Spanish');
    expect(resolveLanguageLabel('ita', en)).toBe('Italian');
    expect(resolveLanguageLabel('rus', en)).toBe('Russian');
    expect(resolveLanguageLabel('ara', en)).toBe('Arabic');
    expect(resolveLanguageLabel('por', en)).toBe('Portuguese');
    expect(resolveLanguageLabel('nld', en)).toBe('Dutch');
    expect(resolveLanguageLabel('jpn', en)).toBe('Japanese');
    expect(resolveLanguageLabel('kor', en)).toBe('Korean');
    expect(resolveLanguageLabel('zho', en)).toBe('Chinese');
    expect(resolveLanguageLabel('pol', en)).toBe('POL');
    expect(resolveLanguageLabel('und', en)).toBeUndefined();
    expect(resolveLanguageLabel('unknown', en)).toBeUndefined();
    expect(resolveLanguageLabel('  ', en)).toBeUndefined();
    expect(resolveLanguageLabel(undefined, en)).toBeUndefined();
    expect(resolveLanguageLabel('constructor', en)).toBe('CONSTRUCTOR');
    expect(resolveLanguageLabel('toString', en)).toBe('TOSTRING');
    expect(resolveLanguageLabel('__proto__', en)).toBeUndefined();

    const tr = createAppI18n('tr');
    expect(tr.t('player.play')).toBe('Oynat');
    expect(tr.t('player.pause')).toBe('Duraklat');
    expect(tr.t('player.seekBack')).toBe('-10 sn');
    expect(tr.t('player.seekForward')).toBe('+10 sn');
    expect(tr.t('player.tracks')).toBe('Ses ve Altyazı');
    expect(tr.t('player.audioTracks')).toBe('Ses');
    expect(tr.t('player.subtitleTracks')).toBe('Altyazı');
    expect(tr.t('player.subtitlesOff')).toBe('Kapalı');
    expect(tr.t('player.closeTracks')).toBe('Kapat');
    expect(tr.t('player.trackNumber', { number: 2 })).toBe('Parça 2');

    expect(resolveLanguageLabel('tur', tr)).toBe('Türkçe');
    expect(resolveLanguageLabel('tr', tr)).toBe('Türkçe');
    expect(resolveLanguageLabel('eng', tr)).toBe('İngilizce');
    expect(resolveLanguageLabel('en', tr)).toBe('İngilizce');
    expect(resolveLanguageLabel('de', tr)).toBe('Almanca');
    expect(resolveLanguageLabel('fre', tr)).toBe('Fransızca');
    expect(resolveLanguageLabel('dut', tr)).toBe('Felemenkçe');
    expect(resolveLanguageLabel('chi', tr)).toBe('Çince');
    expect(resolveLanguageLabel('pol', tr)).toBe('POL');
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
