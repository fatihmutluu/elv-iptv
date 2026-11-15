import type { AttemptToken, EngineEvent, LoadOptions, MediaTracks, TrackInfo } from '@elv/playback';
import type { MpvCommand } from './codec.ts';

interface TrackPreference {
  id: string;
  language?: string;
  label?: string;
}

type SubtitlePreference =
  | { kind: 'default' }
  | { kind: 'off' }
  | { kind: 'selected'; choice: TrackPreference };

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

const posInt = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isInteger(x) && x > 0 ? x : undefined;

const cleanString = (x: unknown): string | undefined => {
  if (typeof x !== 'string') return undefined;
  const trimmed = x.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const cleanLanguage = (x: unknown): string | undefined => {
  const lang = cleanString(x);
  return lang !== undefined && lang.toLowerCase() !== 'und' ? lang : undefined;
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

  return {
    audio,
    subtitles,
    selectedAudioId,
    selectedSubtitleId,
  };
}

/** Builds `['set_property', 'aid', <n>]` for an `"a:<n>"` track ID, or `undefined` if malformed. */
export function parseAudioTrackCommand(id: string): MpvCommand | undefined {
  const match = /^a:([1-9]\d*)$/.exec(id);
  return match ? ['set_property', 'aid', Number(match[1])] : undefined;
}

/** Builds `['set_property', 'sid', <n>]` for `"s:<n>"` or `['set_property', 'sid', 'no']` for `null`. */
export function parseSubtitleTrackCommand(id: string | null): MpvCommand | undefined {
  if (id === null) return ['set_property', 'sid', 'no'];
  const match = /^s:([1-9]\d*)$/.exec(id);
  return match ? ['set_property', 'sid', Number(match[1])] : undefined;
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

function mediaTracksEqual(a: MediaTracks | undefined, b: MediaTracks): boolean {
  if (!a) return false;
  return (
    a.selectedAudioId === b.selectedAudioId &&
    a.selectedSubtitleId === b.selectedSubtitleId &&
    trackListsEqual(a.audio, b.audio) &&
    trackListsEqual(a.subtitles, b.subtitles)
  );
}

function resolveChoice(
  tracks: readonly TrackInfo[],
  wanted: TrackPreference,
): TrackInfo | undefined {
  const exact = tracks.find((t) => t.id === wanted.id);
  if (exact && (wanted.language === undefined || exact.language === wanted.language)) {
    return exact;
  }
  if (wanted.language !== undefined && wanted.label !== undefined) {
    const both = tracks.find((t) => t.language === wanted.language && t.label === wanted.label);
    if (both) return both;
  }
  if (wanted.language !== undefined) {
    const byLang = tracks.find((t) => t.language === wanted.language);
    if (byLang) return byLang;
  }
  if (wanted.label !== undefined) {
    const byLabel = tracks.find((t) => t.label === wanted.label);
    if (byLabel) return byLabel;
  }
  return exact;
}

function toPreference(id: string, matched: TrackInfo | undefined): TrackPreference {
  return {
    id,
    ...(matched?.language === undefined ? {} : { language: matched.language }),
    ...(matched?.label === undefined ? {} : { label: matched.label }),
  };
}

/** Per-engine tracker of mpv `track-list`/`aid`/`sid` state and user track preferences across reloads. */
export interface TrackTracker {
  onLoad(options?: LoadOptions): void;
  onRetryOrRecreate(): void;
  onStop(): void;
  beginMedia(token: AttemptToken): void;
  adopt(token: AttemptToken): void;
  property(name: string, value: unknown): EngineEvent[];
  selectAudio(id: string): MpvCommand | undefined;
  selectSubtitle(id: string | null): MpvCommand | undefined;
  /** Commands to re-apply saved audio/subtitle preferences once a reloaded file's tracks are ready. */
  reconcileCommands(): MpvCommand[];
}

/** Creates a `TrackTracker` that deduplicates `tracks` events and preserves choices across reloads. */
export function createTrackTracker(): TrackTracker {
  let token: AttemptToken | undefined;
  let rawTrackList: unknown;
  let aid: unknown = 'auto';
  let sid: unknown = 'auto';
  let lastEmitted: MediaTracks | undefined;
  let reconciled = false;
  let audioPref: TrackPreference | undefined;
  let subPref: SubtitlePreference = { kind: 'default' };

  const resetFileState = (): void => {
    token = undefined;
    rawTrackList = undefined;
    aid = 'auto';
    sid = 'auto';
    lastEmitted = undefined;
    reconciled = false;
  };

  const currentTracks = (): MediaTracks | undefined =>
    Array.isArray(rawTrackList) ? inspectMpvTracks(rawTrackList, aid, sid) : undefined;

  const emitIfChanged = (): EngineEvent[] => {
    if (token === undefined) return [];
    const next = currentTracks();
    if (!next || mediaTracksEqual(lastEmitted, next)) return [];
    lastEmitted = next;
    return [{ attempt: token, type: 'tracks', tracks: next }];
  };

  return {
    onLoad(options) {
      resetFileState();
      if (options?.audioTrackId === undefined) {
        audioPref = undefined;
      } else if (audioPref?.id !== options.audioTrackId) {
        audioPref = { id: options.audioTrackId };
      }

      if (options === undefined || options.subtitleTrackId === undefined) {
        subPref = { kind: 'default' };
      } else if (options.subtitleTrackId === null) {
        subPref = { kind: 'off' };
      } else if (subPref.kind !== 'selected' || subPref.choice.id !== options.subtitleTrackId) {
        subPref = { kind: 'selected', choice: { id: options.subtitleTrackId } };
      }
    },

    onRetryOrRecreate() {
      resetFileState();
    },

    onStop() {
      resetFileState();
      audioPref = undefined;
      subPref = { kind: 'default' };
    },

    beginMedia(nextToken) {
      resetFileState();
      token = nextToken;
    },

    adopt(nextToken) {
      if (token !== undefined && nextToken > token) token = nextToken;
    },

    property(name, value) {
      if (name === 'track-list') rawTrackList = value;
      else if (name === 'aid') aid = value;
      else if (name === 'sid') sid = value;
      else return [];
      return emitIfChanged();
    },

    selectAudio(id) {
      const cmd = parseAudioTrackCommand(id);
      if (!cmd) return undefined;
      const matched = currentTracks()?.audio.find((t) => t.id === id);
      audioPref = toPreference(id, matched);
      return cmd;
    },

    selectSubtitle(id) {
      const cmd = parseSubtitleTrackCommand(id);
      if (!cmd) return undefined;
      if (id === null) {
        subPref = { kind: 'off' };
      } else {
        const matched = currentTracks()?.subtitles.find((t) => t.id === id);
        subPref = { kind: 'selected', choice: toPreference(id, matched) };
      }
      return cmd;
    },

    reconcileCommands() {
      if (reconciled) return [];
      const snapshot = currentTracks();
      if (!snapshot) return [];
      reconciled = true;
      const commands: MpvCommand[] = [];

      if (audioPref !== undefined) {
        const resolved = resolveChoice(snapshot.audio, audioPref);
        if (resolved) {
          audioPref = toPreference(resolved.id, resolved);
          if (snapshot.selectedAudioId !== resolved.id) {
            const cmd = parseAudioTrackCommand(resolved.id);
            if (cmd) commands.push(cmd);
          }
        }
      }

      if (subPref.kind === 'off') {
        if (sid !== false && sid !== 'no') {
          commands.push(['set_property', 'sid', 'no']);
        }
      } else if (subPref.kind === 'selected') {
        const resolved = resolveChoice(snapshot.subtitles, subPref.choice);
        if (resolved) {
          subPref = { kind: 'selected', choice: toPreference(resolved.id, resolved) };
          if (snapshot.selectedSubtitleId !== resolved.id) {
            const cmd = parseSubtitleTrackCommand(resolved.id);
            if (cmd) commands.push(cmd);
          }
        }
      }

      return commands;
    },
  };
}
