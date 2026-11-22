import type { ElvError } from '@elv/domain';
import type { AppI18n, MessageId } from '@elv/i18n';
import type { DetailTechnicalMeta } from '../shared/detail-target';

/** Localized message and actionable recovery hint for a series seasons error. */
export interface DescribedDetailError {
  readonly messageId: MessageId;
  readonly hintId: MessageId;
}

/** Minimum trimmed synopsis character length before displaying the expandable Read more toggle (`#398`). */
export const SYNOPSIS_EXPAND_THRESHOLD = 180;

/** Ordered pre-play audio language options cycled on Detail screens (`''` = Default). */
export const PREPLAY_AUDIO_OPTIONS = ['', 'tr', 'en', 'de', 'fr', 'es'] as const;

/** Ordered pre-play subtitle language options cycled on Detail screens (`''` = Default, `'off'` = Off). */
export const PREPLAY_SUBTITLE_OPTIONS = ['', 'off', 'tr', 'en', 'de', 'fr', 'es'] as const;

/** One crisp technical metadata badge derived from {@link DetailTechnicalMeta}. */
export interface DetailTechnicalBadge {
  readonly key: 'resolution' | 'hdr' | 'codec' | 'audioChannels' | 'container' | 'durationMin';
  readonly label: string;
}

const LANG_LABEL_IDS: Readonly<Record<string, MessageId>> = {
  tr: 'player.lang.tr',
  en: 'player.lang.en',
  de: 'player.lang.de',
  fr: 'player.lang.fr',
  es: 'player.lang.es',
};

/** Normalizes an optional initial language preference into a supported pre-play option value. */
export function normalizePrePlayLang(lang: string | undefined, options: readonly string[]): string {
  const normalized = lang?.trim().toLowerCase() ?? '';
  return options.includes(normalized) ? normalized : '';
}

/** Advances a pre-play track language selector cleanly through its ordered option ring. */
export function cyclePrePlayOption(options: readonly string[], current: string): string {
  if (options.length === 0) return '';
  const idx = options.indexOf(current);
  const nextIdx = idx < 0 ? 1 % options.length : (idx + 1) % options.length;
  return options[nextIdx] ?? '';
}

/** Formats a pre-play track option code into a localized display label. */
export function formatPrePlayLangLabel(lang: string, t: AppI18n['t']): string {
  if (!lang) return t('detail.trackDefault');
  if (lang === 'off') return t('player.subtitlesOff');
  const messageId = LANG_LABEL_IDS[lang];
  return messageId ? t(messageId) : lang.toUpperCase();
}

/** Extracts clean, non-empty technical badges from optional {@link DetailTechnicalMeta}. */
export function buildTechnicalBadges(
  meta: DetailTechnicalMeta | undefined,
): DetailTechnicalBadge[] {
  if (!meta) return [];
  const badges: DetailTechnicalBadge[] = [];
  const pushStr = (
    key: Exclude<DetailTechnicalBadge['key'], 'durationMin'>,
    value: string | undefined,
    upper = false,
  ) => {
    const trimmed = value?.trim();
    if (!trimmed) return;
    badges.push({ key, label: upper ? trimmed.toUpperCase() : trimmed });
  };
  pushStr('resolution', meta.resolution);
  pushStr('hdr', meta.hdr);
  pushStr('codec', meta.codec);
  pushStr('audioChannels', meta.audioChannels);
  pushStr('container', meta.container, true);
  if (
    typeof meta.durationMin === 'number' &&
    Number.isFinite(meta.durationMin) &&
    meta.durationMin > 0
  ) {
    badges.push({ key: 'durationMin', label: `${Math.round(meta.durationMin)}m` });
  }
  return badges;
}

/** Maps a `CatalogService.seasons` {@link ElvError} to localized copy and recovery hint ids. */
export function describeDetailSeasonsError(error: ElvError): DescribedDetailError {
  if (error.category === 'auth') {
    if (
      error.code === 'invalid-credentials' ||
      error.code === 'http-401' ||
      error.code === 'http-403'
    ) {
      return {
        messageId: 'source.error.invalidCredentials',
        hintId: 'source.hint.invalidCredentials',
      };
    }
    return {
      messageId: 'source.error.accountExpired',
      hintId: 'source.hint.accountExpired',
    };
  }
  if (error.category === 'network') {
    if (error.code === 'rate-limited' || error.code === 'http-429' || error.code === 'http-509') {
      return {
        messageId: 'source.error.rateLimited',
        hintId: 'source.hint.rateLimited',
      };
    }
    if (error.code === 'timeout') {
      return {
        messageId: 'source.error.timeout',
        hintId: 'source.hint.timeout',
      };
    }
    return {
      messageId: 'source.error.unreachable',
      hintId: 'source.hint.unreachable',
    };
  }
  if (error.code === 'item-not-found' || error.code === 'http-404') {
    return {
      messageId: 'player.error.itemNotFound',
      hintId: 'player.hint.itemNotFound',
    };
  }
  return {
    messageId: 'source.error.storage',
    hintId: 'source.hint.storage',
  };
}
