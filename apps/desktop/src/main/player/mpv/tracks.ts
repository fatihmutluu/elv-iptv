import type { AttemptToken, EngineEvent, LoadOptions, MediaTracks } from '@elv/playback';
import type { MpvCommand } from './codec.ts';
import {
  inspectMpvTracks,
  mediaTracksEqual,
  parseAudioTrackCommand,
  parseSubtitleTrackCommand,
  resolveChoice,
  type TrackPreference,
  toPreference,
} from './track-snapshot.ts';

type SubtitlePreference =
  | { kind: 'default' }
  | { kind: 'off' }
  | { kind: 'selected'; choice: TrackPreference };

/** Per-engine tracker of mpv `track-list`/`aid`/`sid` state and user track preferences across reloads. */
export interface TrackTracker {
  onLoad(options?: LoadOptions): void;
  onRetryOrRecreate(): void;
  onStop(): void;
  beginMedia(token: AttemptToken): void;
  onFileLoaded(): void;
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
  let fileLoaded = false;
  let sentSidNo = false;
  let audioReconciled = false;
  let subReconciled = false;
  let audioPref: TrackPreference | undefined;
  let subPref: SubtitlePreference = { kind: 'default' };

  const resetFileState = (): void => {
    token = undefined;
    rawTrackList = undefined;
    aid = 'auto';
    sid = 'auto';
    lastEmitted = undefined;
    fileLoaded = false;
    sentSidNo = false;
    audioReconciled = false;
    subReconciled = false;
  };

  const currentTracks = (): MediaTracks | undefined =>
    Array.isArray(rawTrackList) ? inspectMpvTracks(rawTrackList, aid, sid) : undefined;

  const backfillMetadata = (snapshot: MediaTracks): void => {
    if (
      audioReconciled &&
      audioPref !== undefined &&
      audioPref.language === undefined &&
      audioPref.label === undefined
    ) {
      const currentId = audioPref.id;
      const exact = snapshot.audio.find((t) => t.id === currentId);
      if (exact) audioPref = toPreference(exact.id, exact, audioPref);
    }
    if (
      subReconciled &&
      subPref.kind === 'selected' &&
      subPref.choice.language === undefined &&
      subPref.choice.label === undefined
    ) {
      const currentId = subPref.choice.id;
      const exact = snapshot.subtitles.find((t) => t.id === currentId);
      if (exact) {
        subPref = { kind: 'selected', choice: toPreference(exact.id, exact, subPref.choice) };
      }
    }
  };

  const emitIfChanged = (): EngineEvent[] => {
    if (token === undefined) return [];
    const next = currentTracks();
    if (!next) return [];
    backfillMetadata(next);
    if (mediaTracksEqual(lastEmitted, next)) return [];
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

    onFileLoaded() {
      fileLoaded = true;
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
      audioPref = toPreference(id, matched, audioPref);
      if (token !== undefined) audioReconciled = true;
      return cmd;
    },

    selectSubtitle(id) {
      const cmd = parseSubtitleTrackCommand(id);
      if (!cmd) return undefined;
      if (id === null) {
        subPref = { kind: 'off' };
        if (token !== undefined) {
          sentSidNo = true;
          subReconciled = true;
        }
      } else {
        sentSidNo = false;
        const matched = currentTracks()?.subtitles.find((t) => t.id === id);
        const prev = subPref.kind === 'selected' ? subPref.choice : undefined;
        subPref = { kind: 'selected', choice: toPreference(id, matched, prev) };
        if (token !== undefined) subReconciled = true;
      }
      return cmd;
    },

    reconcileCommands() {
      if (audioReconciled && subReconciled) return [];
      const snapshot = currentTracks();
      const commands: MpvCommand[] = [];

      if (!audioReconciled) {
        if (audioPref === undefined) {
          if (snapshot) audioReconciled = true;
        } else if (snapshot) {
          const resolved = resolveChoice(snapshot.audio, audioPref);
          if (resolved) {
            audioReconciled = true;
            audioPref = toPreference(resolved.id, resolved, audioPref);
            if (snapshot.selectedAudioId !== resolved.id) {
              const cmd = parseAudioTrackCommand(resolved.id);
              if (cmd) commands.push(cmd);
            }
          }
        }
      }

      if (!subReconciled) {
        if (subPref.kind === 'default') {
          if (snapshot) subReconciled = true;
        } else if (subPref.kind === 'off') {
          if (sid === 'no' || sentSidNo) {
            subReconciled = true;
          } else if (fileLoaded || (snapshot !== undefined && snapshot.subtitles.length > 0)) {
            sentSidNo = true;
            subReconciled = true;
            commands.push(['set_property', 'sid', 'no']);
          }
        } else if (snapshot) {
          const resolved = resolveChoice(snapshot.subtitles, subPref.choice);
          if (resolved) {
            subReconciled = true;
            subPref = {
              kind: 'selected',
              choice: toPreference(resolved.id, resolved, subPref.choice),
            };
            if (snapshot.selectedSubtitleId !== resolved.id) {
              const cmd = parseSubtitleTrackCommand(resolved.id);
              if (cmd) commands.push(cmd);
            }
          }
        }
      }

      return commands;
    },
  };
}
