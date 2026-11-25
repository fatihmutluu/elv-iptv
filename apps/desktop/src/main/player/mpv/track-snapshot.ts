import { extractLanguageCodeFromLabel, normalizeLanguageCode, sameLanguageCode } from '@elv/domain';
import type { MediaTracks, ProgramInfo, TrackInfo, VideoQualityOption } from '@elv/playback';
import type { MpvCommand } from './codec.ts';

/** Saved user preference for an audio or subtitle track across reloads. */
export interface TrackPreference {
  id: string;
  language?: string;
  label?: string;
}

const MAX_MPV_TRACK_ID = 0x7fffffff;
const MAX_DELAY_MS = 30_000;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

const posInt = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isInteger(x) && x > 0 && x <= MAX_MPV_TRACK_ID ? x : undefined;

const nonNegInt = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= MAX_MPV_TRACK_ID ? x : undefined;

const posFinite = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : undefined;

/** Converts an observed mpv delay property (seconds) to clamped milliseconds, ignoring null/non-finite values. */
export function parseMpvDelayMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(-MAX_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(value * 1000))) + 0;
}

function formatVideoQualityLabel(
  height: number | undefined,
  bitrateBps: number | undefined,
  codec: string | undefined,
  title: string | undefined,
  rawId: number,
): string {
  if (height !== undefined) return `${height}p`;
  if (bitrateBps !== undefined) {
    return bitrateBps >= 1_000_000
      ? `${(bitrateBps / 1_000_000).toFixed(1)} Mbps`
      : `${Math.max(1, Math.round(bitrateBps / 1000))} kbps`;
  }
  if (codec !== undefined) return codec.toUpperCase();
  if (title !== undefined) return title;
  return `Video ${rawId}`;
}

function deduplicateVideoQualities(candidates: VideoQualityOption[]): VideoQualityOption[] {
  candidates.sort((a, b) => {
    const byHeight = (b.height ?? 0) - (a.height ?? 0);
    if (byHeight !== 0) return byHeight;
    const byBitrate = (b.bitrateBps ?? 0) - (a.bitrateBps ?? 0);
    if (byBitrate !== 0) return byBitrate;
    const byWidth = (b.width ?? 0) - (a.width ?? 0);
    if (byWidth !== 0) return byWidth;
    const byFps = (b.fps ?? 0) - (a.fps ?? 0);
    if (byFps !== 0) return byFps;
    return Number(a.id) - Number(b.id);
  });
  const seenIds = new Set<string>();
  const seenResBitrate = new Set<string>();
  const result: VideoQualityOption[] = [];
  for (const option of candidates) {
    if (seenIds.has(option.id)) continue;
    if (option.height !== undefined) {
      const key = `${option.programId ?? ''}:${option.height}:${option.bitrateBps ?? 0}`;
      if (seenResBitrate.has(key)) continue;
      seenResBitrate.add(key);
    }
    seenIds.add(option.id);
    result.push(option);
  }
  return result;
}

const cleanString = (x: unknown): string | undefined => {
  if (typeof x !== 'string') return undefined;
  const trimmed = x.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** True when both language tags normalize to the same determined ISO 639 code. */
export const sameLanguage = sameLanguageCode;

const cleanLanguage = (x: unknown): string | undefined => {
  const lang = cleanString(x);
  return lang !== undefined && normalizeLanguageCode(lang) !== undefined ? lang : undefined;
};

const extractProgramNumber = (raw: Record<string, unknown>): number | undefined =>
  nonNegInt(raw['program-id']) ?? nonNegInt(raw['demux-via-program']);

const extractServiceName = (raw: Record<string, unknown>): string | undefined =>
  cleanString(raw['service-name']) ??
  cleanString(raw['program-title']) ??
  cleanString(raw['service_name']);

/** Maps mpv's `track-list`, `aid`, `sid`, `secondary-sid`, manual video quality, and `program` into a `MediaTracks` snapshot. */
export function inspectMpvTracks(
  trackList: unknown,
  aid: unknown,
  sid: unknown,
  secondarySid?: unknown,
  manualVideoQualityId?: string | null,
  program?: unknown,
): MediaTracks {
  const entries = Array.isArray(trackList) ? trackList : [];
  const audio: TrackInfo[] = [];
  const subtitles: TrackInfo[] = [];
  const videoCandidates: VideoQualityOption[] = [];
  const programMeta = new Map<number, { serviceName?: string }>();
  let selectedAudioFromList: string | null = null;
  let selectedSubFromList: string | null = null;
  let selectedVideoProgramId: string | null = null;

  const noteProgram = (
    progNum: number | undefined,
    raw: Record<string, unknown>,
  ): string | undefined => {
    if (progNum === undefined) return undefined;
    const serviceName = extractServiceName(raw);
    const existing = programMeta.get(progNum);
    if (!existing) {
      programMeta.set(progNum, serviceName === undefined ? {} : { serviceName });
    } else if (existing.serviceName === undefined && serviceName !== undefined) {
      existing.serviceName = serviceName;
    }
    return String(progNum);
  };

  for (const raw of entries) {
    if (!isRecord(raw)) continue;
    const rawId = posInt(raw['id']);
    const type = raw['type'];
    if (rawId === undefined) continue;

    if (type === 'video') {
      if (raw['albumart'] === true) continue;
      const programId = noteProgram(extractProgramNumber(raw), raw);
      if (selectedVideoProgramId === null && raw['selected'] === true && programId !== undefined) {
        selectedVideoProgramId = programId;
      }
      const width = posInt(raw['demux-w']);
      const height = posInt(raw['demux-h']);
      const rawBitrate = posFinite(raw['hls-bitrate']) ?? posFinite(raw['demux-bitrate']);
      const bitrateBps = rawBitrate === undefined ? undefined : Math.round(rawBitrate);
      const fps = posFinite(raw['demux-fps']);
      const codec = cleanString(raw['codec']);
      const title = cleanString(raw['title']);
      videoCandidates.push({
        id: String(rawId),
        label: formatVideoQualityLabel(height, bitrateBps, codec, title, rawId),
        ...(width === undefined ? {} : { width }),
        ...(height === undefined ? {} : { height }),
        ...(bitrateBps === undefined ? {} : { bitrateBps }),
        ...(fps === undefined ? {} : { fps }),
        ...(programId === undefined ? {} : { programId }),
      });
      continue;
    }

    if (type !== 'audio' && type !== 'sub') continue;

    const id = type === 'audio' ? `a:${rawId}` : `s:${rawId}`;
    const label = cleanString(raw['title']);
    const language = cleanLanguage(raw['lang']) ?? extractLanguageCodeFromLabel(label);
    const codec = cleanString(raw['codec']);
    const channels =
      type === 'audio'
        ? (posInt(raw['demux-channel-count']) ?? posInt(raw['audio-channels']))
        : undefined;
    const forced = raw['forced'] === true;
    const isDefault = raw['default'] === true;
    const external = type === 'sub' && raw['external'] === true;
    const programId = external ? undefined : noteProgram(extractProgramNumber(raw), raw);

    const info: TrackInfo = {
      id,
      ...(language === undefined ? {} : { language }),
      ...(label === undefined ? {} : { label }),
      ...(codec === undefined ? {} : { codec }),
      ...(channels === undefined ? {} : { channels }),
      ...(forced ? { forced: true } : {}),
      ...(isDefault ? { isDefault: true } : {}),
      ...(external ? { external: true } : {}),
      ...(programId === undefined ? {} : { programId }),
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

  const secondaryDisabled =
    secondarySid === undefined || secondarySid === false || secondarySid === 'no';
  const activeSecondarySid = secondaryDisabled ? undefined : posInt(secondarySid);
  const rawSecondaryId =
    activeSecondarySid !== undefined && subtitles.some((t) => t.id === `s:${activeSecondarySid}`)
      ? `s:${activeSecondarySid}`
      : null;
  const selectedSecondarySubtitleId =
    rawSecondaryId !== null && rawSecondaryId !== selectedSubtitleId ? rawSecondaryId : null;

  const videoQualities =
    videoCandidates.length > 1 ? deduplicateVideoQualities(videoCandidates) : [];
  const selectedVideoQualityId =
    videoQualities.length > 1 &&
    manualVideoQualityId !== undefined &&
    manualVideoQualityId !== null &&
    videoQualities.some((q) => q.id === manualVideoQualityId)
      ? manualVideoQualityId
      : null;

  const programs: ProgramInfo[] =
    programMeta.size > 1
      ? [...programMeta.entries()]
          .sort(([a], [b]) => a - b)
          .map(([programNumber, meta]) => ({
            id: String(programNumber),
            label: meta.serviceName ?? `Program ${programNumber}`,
            ...(meta.serviceName === undefined ? {} : { serviceName: meta.serviceName }),
            programNumber,
          }))
      : [];

  let selectedProgramId: string | null | undefined;
  if (programs.length > 1) {
    const observedProgNum =
      nonNegInt(program) ?? (typeof program === 'string' ? parseProgramNumber(program) : undefined);
    const observedProgId = observedProgNum === undefined ? undefined : String(observedProgNum);
    const selectedAudioProgramId =
      selectedAudioId === null ? undefined : audio.find((t) => t.id === selectedAudioId)?.programId;
    if (observedProgId !== undefined && programs.some((p) => p.id === observedProgId)) {
      selectedProgramId = observedProgId;
    } else if (
      selectedVideoProgramId !== null &&
      programs.some((p) => p.id === selectedVideoProgramId)
    ) {
      selectedProgramId = selectedVideoProgramId;
    } else if (
      selectedAudioProgramId !== undefined &&
      programs.some((p) => p.id === selectedAudioProgramId)
    ) {
      selectedProgramId = selectedAudioProgramId;
    } else {
      selectedProgramId = programs[0]?.id ?? null;
    }
  }

  return {
    audio,
    subtitles,
    selectedAudioId,
    selectedSubtitleId,
    ...(selectedSecondarySubtitleId !== null ? { selectedSecondarySubtitleId } : {}),
    ...(videoQualities.length > 1 ? { videoQualities, selectedVideoQualityId } : {}),
    ...(programs.length > 1 ? { programs, selectedProgramId } : {}),
  };
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

/** Builds `['set_property', 'secondary-sid', <n>]` for `"s:<n>"` or `['set_property', 'secondary-sid', 'no']` for `null`. */
export function parseSecondarySubtitleTrackCommand(id: string | null): MpvCommand | undefined {
  if (id === null) return ['set_property', 'secondary-sid', 'no'];
  const match = /^s:([1-9]\d{0,9})$/.exec(id);
  if (!match) return undefined;
  const num = Number(match[1]);
  return Number.isSafeInteger(num) && num <= MAX_MPV_TRACK_ID
    ? ['set_property', 'secondary-sid', num]
    : undefined;
}

/** Builds `['set_property', 'vid', <n>]` for `"<n>"` or `['set_property', 'vid', 'auto']` for `null`. */
export function parseVideoQualityCommand(id: string | null): MpvCommand | undefined {
  if (id === null) return ['set_property', 'vid', 'auto'];
  const match = /^([1-9]\d{0,9})$/.exec(id);
  if (!match) return undefined;
  const num = Number(match[1]);
  return Number.isSafeInteger(num) && num <= MAX_MPV_TRACK_ID
    ? ['set_property', 'vid', num]
    : undefined;
}

/** Parses a canonical non-negative MPEG-TS program number (`"0"`..`"2147483647"`) for mpv (`#304`). */
export function parseProgramNumber(id: string): number | undefined {
  const match = /^(0|[1-9]\d{0,9})$/.exec(id);
  if (!match) return undefined;
  const num = Number(match[1]);
  return Number.isSafeInteger(num) && num >= 0 && num <= MAX_MPV_TRACK_ID ? num : undefined;
}

/** Builds `['set_property', 'program', <n>]` for a valid numeric MPEG-TS program ID, or `undefined` if malformed (`#304`). */
export function parseProgramCommand(id: string): MpvCommand | undefined {
  const num = parseProgramNumber(id);
  return num === undefined ? undefined : ['set_property', 'program', num];
}

function programsEqual(
  a: readonly ProgramInfo[] | undefined,
  b: readonly ProgramInfo[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      !x ||
      !y ||
      x.id !== y.id ||
      x.label !== y.label ||
      x.serviceName !== y.serviceName ||
      x.programNumber !== y.programNumber
    ) {
      return false;
    }
  }
  return true;
}

function videoQualitiesEqual(
  a: readonly VideoQualityOption[] | undefined,
  b: readonly VideoQualityOption[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      !x ||
      !y ||
      x.id !== y.id ||
      x.label !== y.label ||
      x.width !== y.width ||
      x.height !== y.height ||
      x.bitrateBps !== y.bitrateBps ||
      x.fps !== y.fps ||
      x.programId !== y.programId
    ) {
      return false;
    }
  }
  return true;
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
      Boolean(x.isDefault) !== Boolean(y.isDefault) ||
      Boolean(x.external) !== Boolean(y.external) ||
      x.programId !== y.programId
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
    a.selectedSecondarySubtitleId === b.selectedSecondarySubtitleId &&
    a.selectedVideoQualityId === b.selectedVideoQualityId &&
    a.selectedProgramId === b.selectedProgramId &&
    trackListsEqual(a.audio, b.audio) &&
    trackListsEqual(a.subtitles, b.subtitles) &&
    videoQualitiesEqual(a.videoQualities, b.videoQualities) &&
    programsEqual(a.programs, b.programs)
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
