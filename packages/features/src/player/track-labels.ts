import { type AppI18n, enMessages, resolveLanguageLabel, trMessages } from '@elv/i18n';
import type { TrackInfo } from '@elv/playback';

const EN_LOOKUP: Pick<AppI18n, 't'> = { t: (id) => enMessages[id] };
const TR_LOOKUP: Pick<AppI18n, 't'> = { t: (id) => trMessages[id] };

function isRedundantLabel(
  rawLabel: string,
  rawLanguage: string | undefined,
  localizedLang: string | undefined,
): boolean {
  const lower = rawLabel.toLowerCase();
  if (localizedLang !== undefined && lower === localizedLang.toLowerCase()) return true;
  const trimmedCode = rawLanguage?.trim().toLowerCase();
  if (trimmedCode !== undefined && trimmedCode.length > 0) {
    if (lower === trimmedCode) return true;
    const primary = trimmedCode.split(/[-_]/)[0];
    if (primary !== undefined && lower === primary) return true;
  }
  const enLang = resolveLanguageLabel(rawLanguage, EN_LOOKUP);
  if (enLang !== undefined && lower === enLang.toLowerCase()) return true;
  const trLang = resolveLanguageLabel(rawLanguage, TR_LOOKUP);
  if (trLang !== undefined && lower === trLang.toLowerCase()) return true;
  return false;
}

function primaryTrackName(track: TrackInfo, index: number, i18n: AppI18n): string {
  const lang = resolveLanguageLabel(track.language, i18n);
  const rawLabel = track.label?.trim();
  const cleanLabel =
    rawLabel !== undefined &&
    rawLabel.length > 0 &&
    !isRedundantLabel(rawLabel, track.language, lang)
      ? rawLabel
      : undefined;

  let base: string;
  if (lang !== undefined && cleanLabel !== undefined) {
    base = `${lang} · ${cleanLabel}`;
  } else if (lang !== undefined) {
    base = lang;
  } else if (cleanLabel !== undefined) {
    base = cleanLabel;
  } else {
    base = i18n.t('player.trackNumber', { number: index + 1 });
  }

  return track.forced === true ? `${base} · ${i18n.t('player.trackForced')}` : base;
}

function formatChannelLayout(channels: number | undefined): string | undefined {
  if (channels === undefined || !Number.isFinite(channels) || channels <= 0) return undefined;
  if (channels === 1) return '1.0';
  if (channels === 2) return '2.0';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return `${channels}ch`;
}

function trackDetail(track: TrackInfo): string | undefined {
  const codec = track.codec?.trim();
  const codecText = codec !== undefined && codec.length > 0 ? codec.toUpperCase() : undefined;
  const chanText = formatChannelLayout(track.channels);
  const parts = [codecText, chanText].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Formats a localized display label for an audio or subtitle track, disambiguating duplicate
 * language names across sibling tracks via codec/channel layout or 1-based track index.
 */
export function formatTrackLabel(
  track: TrackInfo,
  index: number,
  siblings: readonly TrackInfo[],
  i18n: AppI18n,
): string {
  const primary = primaryTrackName(track, index, i18n);
  const samePrimary = siblings
    .map((candidate, idx) => ({ candidate, idx, name: primaryTrackName(candidate, idx, i18n) }))
    .filter((entry) => entry.name === primary);

  if (samePrimary.length <= 1) return primary;

  const detail = trackDetail(track);
  if (detail !== undefined) {
    const withDetail = `${primary} (${detail})`;
    const duplicateWithDetail = samePrimary.filter((entry) => {
      const siblingDetail = trackDetail(entry.candidate);
      return siblingDetail === detail;
    });
    if (duplicateWithDetail.length <= 1) return withDetail;
    return `${withDetail} #${index + 1}`;
  }

  return `${primary} #${index + 1}`;
}
