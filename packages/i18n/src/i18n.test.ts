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

  it('localizes catalog discovery, category grid, and detail screen strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['catalog.moviesTitle', 'Movies', 'Filmler'],
      ['catalog.seriesTitle', 'Series', 'Diziler'],
      ['catalog.allCategories', 'All', 'Tümü'],
      ['catalog.filter.all', 'All', 'Tümü'],
      ['catalog.filter.unwatched', 'Unwatched', 'İzlenmemiş'],
      ['catalog.filter.inProgress', 'In progress', 'Devam eden'],
      ['catalog.filter.watched', 'Watched', 'İzlendi'],
      ['catalog.seeAll', 'See all', 'Tümünü gör'],
      ['catalog.loadMoreCategories', 'Load more categories', 'Daha fazla kategori yükle'],
      ['catalog.backToMovies', 'Back to Movies', 'Filmlere dön'],
      ['catalog.backToSeries', 'Back to Series', 'Dizilere dön'],
      ['catalog.emptyFilter', 'No titles match this filter.', 'Bu filtreyle eşleşen yapım yok.'],
      ['catalog.clearFilter', 'Show all', 'Tümünü göster'],
      ['detail.back', 'Back', 'Geri'],
      ['detail.playMovie', 'Play', 'Oynat'],
      ['detail.resumeMovie', 'Resume', 'Devam et'],
      ['detail.episodes', 'Episodes', 'Bölümler'],
      ['detail.moreLikeThis', 'More like this', 'Benzer yapımlar'],
      [
        'detail.noSynopsis',
        'No synopsis available from this source.',
        'Bu kaynak için özet bilgisi bulunmuyor.',
      ],
      ['detail.loadingEpisodes', 'Loading episodes…', 'Bölümler yükleniyor…'],
      ['detail.cast', 'Cast', 'Oyuncular'],
    ];
    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('catalog.itemsCount', { count: 0 })).toBe('0 titles');
    expect(en.t('catalog.itemsCount', { count: 1 })).toBe('1 title');
    expect(en.t('catalog.itemsCount', { count: 24 })).toBe('24 titles');
    expect(tr.t('catalog.itemsCount', { count: 0 })).toBe('0 yapım');
    expect(tr.t('catalog.itemsCount', { count: 1 })).toBe('1 yapım');
    expect(tr.t('catalog.itemsCount', { count: 24 })).toBe('24 yapım');

    expect(en.t('detail.playEpisode', { season: 1, episode: 3 })).toBe('Play S1 E3');
    expect(tr.t('detail.playEpisode', { season: 1, episode: 3 })).toBe('Oynat S1 B3');
    expect(en.t('detail.resumeEpisode', { season: 2, episode: 7 })).toBe('Resume S2 E7');
    expect(tr.t('detail.resumeEpisode', { season: 2, episode: 7 })).toBe('Devam et S2 B7');

    expect(en.t('detail.seasonsCount', { count: 1 })).toBe('1 season');
    expect(en.t('detail.seasonsCount', { count: 5 })).toBe('5 seasons');
    expect(tr.t('detail.seasonsCount', { count: 1 })).toBe('1 sezon');
    expect(tr.t('detail.seasonsCount', { count: 5 })).toBe('5 sezon');

    expect(en.t('detail.seasonOption', { season: 4 })).toBe('Season 4');
    expect(tr.t('detail.seasonOption', { season: 4 })).toBe('4. Sezon');
    expect(en.t('detail.episodeNumbered', { episode: 12, title: 'Finale' })).toBe('12. Finale');
    expect(tr.t('detail.episodeNumbered', { episode: 12, title: 'Finale' })).toBe('12. Finale');
    expect(en.t('detail.durationMin', { minutes: 48 })).toBe('48m');
    expect(tr.t('detail.durationMin', { minutes: 48 })).toBe('48 dk');
    expect(en.t('detail.durationHoursMin', { hours: 2, minutes: 14 })).toBe('2h 14m');
    expect(tr.t('detail.durationHoursMin', { hours: 2, minutes: 14 })).toBe('2 sa 14 dk');
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

  it('localizes search screen, top-bar nav, scope counts, and plural summaries in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const staticCases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['nav.search', 'Search', 'Ara'],
      ['search.title', 'Search', 'Ara'],
      ['search.placeholder', 'Search channels, movies, and series…', 'Kanal, film ve dizi ara…'],
      ['search.clear', 'Clear search', 'Aramayı temizle'],
      ['search.scope.all', 'All', 'Tümü'],
      ['search.recentTitle', 'Recent searches', 'Son aramalar'],
      ['search.clearRecent', 'Clear history', 'Geçmişi temizle'],
      ['search.promptTitle', 'Find anything in your catalog', 'Kataloğunuzda aradığınızı bulun'],
      [
        'search.promptDescription',
        'Search live channels, movies, and series. Accent and Turkish letter differences are matched automatically.',
        'Canlı kanallar, filmler ve diziler arasında arayın. Türkçe karakter ve aksan farkları otomatik eşleştirilir.',
      ],
      ['search.searching', 'Searching…', 'Aranıyor…'],
      [
        'search.noResultsDescription',
        'Try a shorter word, check the spelling, or switch the category filter.',
        'Daha kısa bir kelime deneyin, yazımı kontrol edin veya kategori filtresini değiştirin.',
      ],
      ['search.section.live', 'Live channels', 'Canlı kanallar'],
      ['search.section.movies', 'Movies', 'Filmler'],
      ['search.section.series', 'Series', 'Diziler'],
    ];
    for (const [id, expectedEn, expectedTr] of staticCases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('search.scope.live', { count: 12 })).toBe('Live (12)');
    expect(tr.t('search.scope.live', { count: 12 })).toBe('Canlı (12)');
    expect(en.t('search.scope.movies', { count: 34 })).toBe('Movies (34)');
    expect(tr.t('search.scope.movies', { count: 34 })).toBe('Filmler (34)');
    expect(en.t('search.scope.series', { count: 7 })).toBe('Series (7)');
    expect(tr.t('search.scope.series', { count: 7 })).toBe('Diziler (7)');

    expect(en.t('search.noResultsTitle', { query: 'çağrı' })).toBe('No matches for "çağrı"');
    expect(tr.t('search.noResultsTitle', { query: 'çağrı' })).toBe('"çağrı" için sonuç bulunamadı');

    expect(en.t('search.resultsSummary', { count: 0 })).toBe('0 matches');
    expect(en.t('search.resultsSummary', { count: 1 })).toBe('1 match');
    expect(en.t('search.resultsSummary', { count: 18 })).toBe('18 matches');
    expect(tr.t('search.resultsSummary', { count: 0 })).toBe('0 sonuç');
    expect(tr.t('search.resultsSummary', { count: 1 })).toBe('1 sonuç');
    expect(tr.t('search.resultsSummary', { count: 18 })).toBe('18 sonuç');
  });

  it('localizes Live TV Hub, Mini-Guide, Number Pad, and EPG Grid strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const staticCases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['live.mode.watch', 'Watch', 'İzle'],
      ['live.mode.channels', 'Channels', 'Kanallar'],
      ['live.mode.guide', 'TV Guide', 'TV Rehberi'],
      ['live.miniGuide', 'Mini-Guide', 'Mini Rehber'],
      ['live.prevChannel', 'Previous channel', 'Önceki kanal'],
      ['live.numberPad', 'Channel number', 'Kanal numarası'],
      ['live.numberJump', 'Tune', 'Git'],
      ['live.numberClear', 'Clear', 'Temizle'],
      ['live.watchFullscreen', 'Watch live', 'Canlı izle'],
      ['live.upNext', 'Up next', 'Sıradaki'],
      ['live.noProgramInfo', 'Program information unavailable', 'Program bilgisi yok'],
      ['live.emptyTitle', 'No live channels yet', 'Henüz canlı kanal yok'],
      [
        'live.emptyDescription',
        'Add or refresh a source to load live broadcasts and TV Guide schedules.',
        'Canlı yayınları ve TV rehberini yüklemek için bir kaynak ekleyin veya yenileyin.',
      ],
      ['epg.title', 'TV Guide', 'TV Rehberi'],
      ['epg.now', 'Now', 'Şimdi'],
      ['epg.jumpToLive', 'Jump to live', 'Canlıya dön'],
      ['epg.refreshGuide', 'Refresh guide', 'Rehberi yenile'],
      ['epg.refreshingGuide', 'Refreshing…', 'Yenileniyor…'],
      ['epg.watchNow', 'Watch now', 'Şimdi izle'],
      ['epg.earlier', 'Earlier', 'Önceki'],
      ['epg.later', 'Later', 'Sonraki'],
      [
        'epg.noGuideData',
        'No guide schedule loaded for this window.',
        'Bu zaman aralığı için rehber verisi yok.',
      ],
      ['epg.onAirBadge', 'ON AIR', 'YAYINDA'],
    ];
    for (const [id, expectedEn, expectedTr] of staticCases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('live.numberNotFound', { number: 404 })).toBe('No channel #404');
    expect(tr.t('live.numberNotFound', { number: 404 })).toBe('#404 numaralı kanal yok');
    expect(en.t('live.numberNotFound', { number: '07' })).toBe('No channel #07');
    expect(tr.t('live.numberNotFound', { number: '07' })).toBe('#07 numaralı kanal yok');

    expect(en.t('live.channelsCount', { count: 0 })).toBe('0 channels');
    expect(en.t('live.channelsCount', { count: 1 })).toBe('1 channel');
    expect(en.t('live.channelsCount', { count: 42 })).toBe('42 channels');
    expect(tr.t('live.channelsCount', { count: 0 })).toBe('0 kanal');
    expect(tr.t('live.channelsCount', { count: 1 })).toBe('1 kanal');
    expect(tr.t('live.channelsCount', { count: 42 })).toBe('42 kanal');
  });

  it('localizes player settings, stats HUD, touch lock, next episode, and previous channel strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const staticCases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['player.settings', 'Player settings', 'Oynatıcı ayarları'],
      ['player.settingsBack', 'Back to settings', 'Ayarlara dön'],
      ['player.statsHud', 'Playback stats', 'Oynatma istatistikleri'],
      ['player.stats.on', 'On', 'Açık'],
      ['player.stats.off', 'Off', 'Kapalı'],
      ['player.stats.audioNone', 'No audio track', 'Ses parçası yok'],
      ['player.lockControls', 'Lock controls', 'Kontrolleri kilitle'],
      ['player.unlockControls', 'Unlock controls', 'Kilidi aç'],
      ['player.nextEpisode', 'Next episode', 'Sonraki bölüm'],
      ['player.dismissNextEpisode', 'Dismiss next episode', 'Sonraki bölümü kapat'],
      ['player.jumpPreviousChannel', 'Previous channel', 'Önceki kanal'],
    ];
    for (const [id, expectedEn, expectedTr] of staticCases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('player.stats.latencyMs', { ms: 184 })).toBe('First frame 184 ms');
    expect(tr.t('player.stats.latencyMs', { ms: 184 })).toBe('İlk kare 184 ms');
    expect(en.t('player.nextEpisodeWithLabel', { label: 'S1 E4 · Finale' })).toBe(
      'Next: S1 E4 · Finale',
    );
    expect(tr.t('player.nextEpisodeWithLabel', { label: 'S1 B4 · Final' })).toBe(
      'Sonraki: S1 B4 · Final',
    );
  });

  it('localizes crash recovery (#159) and playback diagnosis (#316) strings in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const staticCases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['crash.title', 'Something went wrong', 'Bir sorun oluştu'],
      [
        'crash.subtitle',
        'The screen ran into an unexpected error. Choose how to recover.',
        'Ekran beklenmeyen bir hatayla karşılaştı. Nasıl devam edeceğinizi seçin.',
      ],
      ['crash.reload', 'Reload', 'Yeniden Yükle'],
      ['crash.clearCache', 'Clear UI Cache', 'Arayüz Önbelleğini Temizle'],
      ['crash.switchSource', 'Switch Source', 'Kaynak Değiştir'],
      [
        'player.diag.offline',
        'You appear to be offline. Check your network connection.',
        'Çevrimdışı görünüyorsunuz. Ağ bağlantınızı kontrol edin.',
      ],
      [
        'player.diag.accountExpired',
        'Your provider account has expired.',
        'Sağlayıcı hesabınızın süresi dolmuş.',
      ],
      [
        'player.diag.accountDisabled',
        'Your provider account is currently disabled.',
        'Sağlayıcı hesabınız şu anda devre dışı.',
      ],
      [
        'player.diag.serverSilent',
        'The server responded with no stream data.',
        'Sunucu yayın verisi göndermedi.',
      ],
      [
        'player.diag.codecUnsupported',
        'This stream format or codec is not supported on this device.',
        'Bu yayın biçimi veya çözücü bu cihazda desteklenmiyor.',
      ],
    ];
    for (const [id, expectedEn, expectedTr] of staticCases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }

    expect(en.t('crash.code', { code: 'TypeError' })).toBe('Reference: TypeError');
    expect(tr.t('crash.code', { code: 'TypeError' })).toBe('Referans: TypeError');
  });

  it('localizes source account warning badges (#170) in English and Turkish', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');

    expect(en.t('sources.badge.trial')).toBe('Trial');
    expect(tr.t('sources.badge.trial')).toBe('Deneme');
    expect(en.t('sources.badge.expired')).toBe('Expired');
    expect(tr.t('sources.badge.expired')).toBe('Süresi doldu');
    expect(en.t('sources.badge.expiringSoon', { days: 1 })).toBe('Expires in 1d');
    expect(tr.t('sources.badge.expiringSoon', { days: 1 })).toBe('1 gün içinde doluyor');
    expect(en.t('sources.badge.expiringSoon', { days: 5 })).toBe('Expires in 5d');
    expect(tr.t('sources.badge.expiringSoon', { days: 5 })).toBe('5 gün içinde doluyor');
  });

  it('localizes Cinema Quietude v2 catalog, live favorites, player OSD, and rail scroll strings', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      ['catalog.categories', 'Categories', 'Kategoriler'],
      ['catalog.chooseCategory', 'Browse categories', 'Kategori seç'],
      ['catalog.continueWatching', 'Continue watching', 'İzlemeye devam et'],
      ['live.mode.favorites', 'Favorites', 'Favoriler'],
      ['live.favoritesEmptyTitle', 'No favorite channels yet', 'Henüz favori kanal yok'],
      [
        'live.favoritesEmptyBody',
        'Star channels in Channels or TV Guide to watch them here.',
        'Burada izlemek için Kanallar veya TV Rehberi ekranından kanalları favorilere ekle.',
      ],
      ['live.browseChannels', 'Browse channels', 'Kanallara göz at'],
      ['live.favoriteAdd', 'Add to Favorites', 'Favorilere ekle'],
      ['live.favoriteRemove', 'Remove from Favorites', 'Favorilerden çıkar'],
      ['player.speed', 'Playback speed', 'Oynatma hızı'],
      ['player.aspect', 'Aspect', 'Görüntü modu'],
      ['player.aspect.fit', 'Fit', 'Sığdır'],
      ['player.aspect.fill', 'Fill', 'Doldur'],
      ['player.deinterlace', 'Deinterlace', 'Taramayı gider'],
      ['player.unmute', 'Unmute', 'Sesi aç'],
      ['player.enterFullscreen', 'Fullscreen', 'Tam ekran'],
      ['player.exitFullscreen', 'Exit fullscreen', 'Tam ekrandan çık'],
      ['rail.scrollLeft', 'Scroll left', 'Sola kaydır'],
      ['rail.scrollRight', 'Scroll right', 'Sağa kaydır'],
    ];
    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }
  });

  it('localizes desktop catalog-worker disconnect recovery banner strings (#435)', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases: ReadonlyArray<readonly [MessageId, string, string]> = [
      [
        'desktop.catalogDisconnected.title',
        'Catalog service stopped unexpectedly',
        'Katalog servisi beklenmedik şekilde durdu',
      ],
      ['desktop.catalogDisconnected.retry', 'Reconnect', 'Yeniden bağlan'],
      ['desktop.catalogDisconnected.reconnecting', 'Reconnecting…', 'Yeniden bağlanıyor…'],
    ];
    for (const [id, expectedEn, expectedTr] of cases) {
      expect(en.t(id)).toBe(expectedEn);
      expect(tr.t(id)).toBe(expectedTr);
    }
  });
});
