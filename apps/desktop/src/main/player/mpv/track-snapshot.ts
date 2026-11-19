import type { MediaTracks, TrackInfo } from '@elv/playback';
import type { MpvCommand } from './codec.ts';

/** Saved user preference for an audio or subtitle track across reloads. */
export interface TrackPreference {
  id: string;
  language?: string;
  label?: string;
}

const MAX_MPV_TRACK_ID = 0x7fffffff;

const UNDETERMINED_CODES: ReadonlySet<string> = new Set(['und', 'zxx', 'mul', 'mis', 'unknown']);

const ISO639_TO_1: ReadonlyMap<string, string> = new Map([
  ['eng', 'en'],
  ['tur', 'tr'],
  ['deu', 'de'],
  ['ger', 'de'],
  ['fra', 'fr'],
  ['fre', 'fr'],
  ['spa', 'es'],
  ['ita', 'it'],
  ['rus', 'ru'],
  ['ara', 'ar'],
  ['por', 'pt'],
  ['nld', 'nl'],
  ['dut', 'nl'],
  ['pol', 'pl'],
  ['zho', 'zh'],
  ['chi', 'zh'],
  ['jpn', 'ja'],
  ['kor', 'ko'],
  ['fas', 'fa'],
  ['per', 'fa'],
  ['ell', 'el'],
  ['gre', 'el'],
  ['ces', 'cs'],
  ['cze', 'cs'],
  ['ron', 'ro'],
  ['rum', 'ro'],
  ['swe', 'sv'],
  ['ukr', 'uk'],
  ['kur', 'ku'],
  ['aze', 'az'],
  ['hin', 'hi'],
  ['heb', 'he'],
  ['hun', 'hu'],
  ['fin', 'fi'],
  ['dan', 'da'],
  ['nor', 'no'],
  ['nob', 'nb'],
  ['nno', 'nn'],
  ['bul', 'bg'],
  ['hrv', 'hr'],
  ['srp', 'sr'],
  ['slk', 'sk'],
  ['slo', 'sk'],
  ['slv', 'sl'],
  ['sqi', 'sq'],
  ['alb', 'sq'],
  ['mkd', 'mk'],
  ['mac', 'mk'],
  ['bos', 'bs'],
  ['kat', 'ka'],
  ['geo', 'ka'],
  ['hye', 'hy'],
  ['arm', 'hy'],
  ['ind', 'id'],
  ['msa', 'ms'],
  ['may', 'ms'],
  ['vie', 'vi'],
  ['tha', 'th'],
]);

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

const posInt = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isInteger(x) && x > 0 && x <= MAX_MPV_TRACK_ID ? x : undefined;

const cleanString = (x: unknown): string | undefined => {
  if (typeof x !== 'string') return undefined;
  const trimmed = x.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

function normalizeLanguageTag(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const primary = trimmed.split(/[-_]/)[0]?.toLowerCase() ?? '';
  if (primary.length === 0 || UNDETERMINED_CODES.has(primary)) return undefined;
  return ISO639_TO_1.get(primary) ?? primary;
}

/** True when both language tags normalize to the same determined ISO 639 code. */
export function sameLanguage(a: string | undefined, b: string | undefined): boolean {
  const normA = normalizeLanguageTag(a);
  const normB = normalizeLanguageTag(b);
  return normA !== undefined && normA === normB;
}

const cleanLanguage = (x: unknown): string | undefined => {
  const lang = cleanString(x);
  return lang !== undefined && normalizeLanguageTag(lang) !== undefined ? lang : undefined;
};

/** Maps mpv's `track-list`, `aid` and `sid` properties into a `MediaTracks` snapshot. */
export function inspectMpvTracks(trackList: unknown, aid: unknown, sid: unknown): MediaTracks {
  const entries = Array.isArray(trackList) ? trackList : [];
  const audio: TrackInfo[] = [];
  const subtitles: TrackInfo[] = [];
  let selectedAudioFromList: string | null = null;
  let selectedSubFromList: string | null = null;

  for (const raw of entries) {
    if (!isRecord(raw)) continue;
    const rawId = posInt(raw['id']);
    const type = raw['type'];
    if (rawId === undefined || (type !== 'audio' && type !== 'sub')) continue;

    const id = type === 'audio' ? `a:${rawId}` : `s:${rawId}`;
    const language = cleanLanguage(raw['lang']);
    const label = cleanString(raw['title']);
    const codec = cleanString(raw['codec']);
    const channels =
      type === 'audio'
        ? (posInt(raw['demux-channel-count']) ?? posInt(raw['audio-channels']))
        : undefined;
    const forced = raw['forced'] === true;
    const isDefault = raw['default'] === true;

    const info: TrackInfo = {
      id,
      ...(language === undefined ? {} : { language }),
      ...(label === undefined ? {} : { label }),
      ...(codec === undefined ? {} : { codec }),
      ...(channels === undefined ? {} : { channels }),
      ...(forced ? { forced: true } : {}),
      ...(isDefault ? { isDefault: true } : {}),
    };

    if (type === 'audio') {
      audio.push(info);
      if (selectedAudioFromList === null && raw['selected'] === true) selectedAudioFromList = id;
    } else {
      subtitles.push(info);
      if (selectedSubFromList === null && raw['selected'] === true) selectedSubFromList = id;
    }
  }

  const audioDisabled = aid === false || aid === 'no';
  const activeAid = posInt(aid);
  const selectedAudioId = audioDisabled
    ? null
    : activeAid !== undefined && audio.some((t) => t.id === `a:${activeAid}`)
      ? `a:${activeAid}`
      : selectedAudioFromList;

  const subDisabled = sid === false || sid === 'no';
  const activeSid = posInt(sid);
  const selectedSubtitleId = subDisabled
    ? null
    : activeSid !== undefined && subtitles.some((t) => t.id === `s:${activeSid}`)
      ? `s:${activeSid}`
      : selectedSubFromList;

  return { audio, subtitles, selectedAudioId, selectedSubtitleId };
}

/** Builds `['set_property', 'aid', <n>]` for an `"a:<n>"` track ID, or `undefined` if malformed. */
export function parseAudioTrackCommand(id: string): MpvCommand | undefined {
  const match = /^a:([1-9]\d{0,9})$/.exec(id);
  if (!match) return undefined;
  const num = Number(match[1]);
  return Number.isSafeInteger(num) && num <= MAX_MPV_TRACK_ID
    ? ['set_property', 'aid', num]
    : undefined;
}

/** Builds `['set_property', 'sid', <n>]` for `"s:<n>"` or `['set_property', 'sid', 'no']` for `null`. */
export function parseSubtitleTrackCommand(id: string | null): MpvCommand | undefined {
  if (id === null) return ['set_property', 'sid', 'no'];
  const match = /^s:([1-9]\d{0,9})$/.exec(id);
  if (!match) return undefined;
  const num = Number(match[1]);
  return Number.isSafeInteger(num) && num <= MAX_MPV_TRACK_ID
    ? ['set_property', 'sid', num]
    : undefined;
}

function trackListsEqual(a: readonly TrackInfo[], b: readonly TrackInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      !x ||
      !y ||
      x.id !== y.id ||
      x.language !== y.language ||
      x.label !== y.label ||
      x.codec !== y.codec ||
      x.channels !== y.channels ||
      Boolean(x.forced) !== Boolean(y.forced) ||
      Boolean(x.isDefault) !== Boolean(y.isDefault)
    ) {
      return false;
    }
  }
  return true;
}

/** Structural equality check for deduplicating `tracks` engine events. */
export function mediaTracksEqual(a: MediaTracks | undefined, b: MediaTracks): boolean {
  if (!a) return false;
  return (
    a.selectedAudioId === b.selectedAudioId &&
    a.selectedSubtitleId === b.selectedSubtitleId &&
    trackListsEqual(a.audio, b.audio) &&
    trackListsEqual(a.subtitles, b.subtitles)
  );
}

/** Resolves a saved track preference against available tracks by exact ID, `(lang + label)`, `lang`, then `label`. */
export function resolveChoice(
  tracks: readonly TrackInfo[],
  wanted: TrackPreference,
): TrackInfo | undefined {
  const exact = tracks.find((t) => t.id === wanted.id);
  if (
    exact &&
    (wanted.language === undefined || sameLanguage(exact.language, wanted.language)) &&
    (wanted.label === undefined || exact.label === undefined || exact.label === wanted.label)
  ) {
    return exact;
  }
  if (wanted.language !== undefined && wanted.label !== undefined) {
    const both = tracks.find(
      (t) => sameLanguage(t.language, wanted.language) && t.label === wanted.label,
    );
    if (both) return both;
  }
  if (wanted.language !== undefined) {
    const byLang = tracks.find((t) => sameLanguage(t.language, wanted.language));
    if (byLang) return byLang;
  }
  if (wanted.label !== undefined) {
    const byLabel = tracks.find((t) => t.label === wanted.label);
    if (byLabel) return byLabel;
  }
  return exact;
}

/** Builds an updated `TrackPreference` preserving known language and label metadata. */
export function toPreference(
  id: string,
  matched: TrackInfo | undefined,
  previous?: TrackPreference,
): TrackPreference {
  const language = matched?.language ?? (previous?.id === id ? previous.language : undefined);
  const label = matched?.label ?? (previous?.id === id ? previous.label : undefined);
  return {
    id,
    ...(language === undefined ? {} : { language }),
    ...(label === undefined ? {} : { label }),
  };
}
