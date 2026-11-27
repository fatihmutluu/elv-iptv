/** English messages for Wave E1 ELV Mode Core Engine (`#511`). */
export const enWaveE1Messages = {
  'settings.section.elvMode': 'ELV Mode',
  'settings.elvMode.subtitle':
    'Transform any IPTV list into a cinema-grade catalog with zero performance overhead.',
  'settings.elvMode.masterTitle': 'ELV Mode',
  'settings.elvMode.masterDescription':
    'Non-destructive enhancement powered by IMDb metadata and smart multi-source merging. Turn off anytime to return to raw provider data.',
  'settings.elvMode.mergeVersions': 'Merge movie & series versions',
  'settings.elvMode.mergeVersionsDesc':
    'Combine duplicates and multi-source copies under one clean card with a source/quality picker.',
  'settings.elvMode.enrichMetadata': 'Clean posters, ratings & rich details',
  'settings.elvMode.enrichMetadataDesc':
    'Load crisp IMDb posters, ratings, and localized synopses directly without double-fetching provider art.',
  'settings.elvMode.titleFormat': 'Title display format',
  'settings.elvMode.titleFormatDesc':
    'Choose how movie and series titles appear across browse, detail, and search.',
  'settings.elvMode.titleFormat.original': 'Original title',
  'settings.elvMode.titleFormat.system': 'System language',
  'settings.elvMode.titleFormat.english': 'English',
  'settings.elvMode.titleFormat.english_system': 'English (System)',
  'settings.elvMode.titleFormat.original_system': 'Original (System)',
  'settings.elvMode.titleFormat.system_english': 'System (English)',
  'settings.elvMode.titleFormat.system_original': 'System (Original)',
  'settings.elvMode.categorySource': 'Category source',
  'settings.elvMode.categorySourceDesc':
    "Browse Movies and Series by clean IMDb genres or keep your IPTV provider's folders.",
  'settings.elvMode.categorySource.imdb': 'IMDb genres',
  'settings.elvMode.categorySource.provider': 'Provider folders',
  'settings.elvMode.smartRecommendations': 'Smart recommendations & trending showcase',
  'settings.elvMode.smartRecommendationsDesc':
    'Personalize picks from your library and trending IMDb lists, automatically hiding disliked items.',
  'settings.elvMode.xray': 'In-player X-Ray (cast & episode info)',
  'settings.elvMode.xrayDesc':
    'Show clickable cast portraits and episode details when you pause playback.',
  'settings.elvMode.liveEnhance': 'Live TV cleanup, quality grouping & failover',
  'settings.elvMode.liveEnhanceDesc':
    'Strip provider tags, group HD/FHD/4K copies across categories, auto-switch on drop, and demote dead streams.',
  'settings.elvMode.verifyRealQuality': 'Real quality verification & broken-version memory',
  'settings.elvMode.verifyRealQualityDesc':
    'Remember true stream resolution to correct mislabeled 4K streams and deprioritize failing copies.',
  'elv.quality.verified': 'Verified {resolution}',
  'elv.quality.fake4k': 'Actual {resolution} (labeled 4K)',
  'elv.quality.unreliable': 'Unreliable',
  'elv.source.from': 'from {source}',
  'elv.versions.title': 'Sources & versions ({count})',
  'elv.matching.background': 'Enhancing catalog in background…',
} as const;
