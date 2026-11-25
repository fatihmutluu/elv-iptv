import {
  type AttemptToken,
  type EngineEvent,
  filterTracksByProgram,
  type LoadOptions,
  type MediaTracks,
} from '@elv/playback';
import type { MpvCommand } from './codec.ts';
import {
  inspectMpvTracks,
  mediaTracksEqual,
  parseAudioTrackCommand,
  parseProgramCommand,
  parseProgramNumber,
  parseSecondarySubtitleTrackCommand,
  parseSubtitleTrackCommand,
  parseVideoQualityCommand,
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
  /** Returns `['set_property', 'secondary-sid', 'no']` when `primaryId` collides with the active secondary track (`#402`). */
  clearSecondaryIfCollides(primaryId: string | null): MpvCommand | undefined;
  selectSecondarySubtitle(id: string | null): MpvCommand | undefined;
  /** Returns `true` while a secondary subtitle track is selected or requested (`#402`). */
  hasActiveSecondarySubtitle(): boolean;
  selectVideoQuality(id: string | null): MpvCommand | undefined;
  /** Selects a service/program inside a multi-program MPEG-TS stream (`#304`). */
  selectProgram(id: string): MpvCommand | undefined;
  /** Emits an updated `tracks` snapshot if local selection state changed (e.g. manual video quality). */
  sync(): EngineEvent[];
  /** Commands to re-apply saved audio/subtitle preferences once a reloaded file's tracks are ready. */
  reconcileCommands(): MpvCommand[];
}

/** Creates a `TrackTracker` that deduplicates `tracks` events and preserves choices across reloads. */
export function createTrackTracker(): TrackTracker {
  let token: AttemptToken | undefined;
  let rawTrackList: unknown;
  let aid: unknown = 'auto';
  let sid: unknown = 'auto';
  let secondarySid: unknown = 'no';
  let program: unknown;
  let manualVideoQualityId: string | null = null;
  let lastEmitted: MediaTracks | undefined;
  let fileLoaded = false;
  let sentSidNo = false;
  let programReconciled = false;
  let audioReconciled = false;
  let subReconciled = false;
  let secondarySubReconciled = false;
  let programPref: string | undefined;
  let audioPref: TrackPreference | undefined;
  let subPref: SubtitlePreference = { kind: 'default' };
  let secondarySubPref: SubtitlePreference = { kind: 'default' };

  const resetFileState = (): void => {
    token = undefined;
    rawTrackList = undefined;
    aid = 'auto';
    sid = 'auto';
    secondarySid = 'no';
    program = undefined;
    manualVideoQualityId = null;
    lastEmitted = undefined;
    fileLoaded = false;
    sentSidNo = false;
    programReconciled = false;
    audioReconciled = false;
    subReconciled = false;
    secondarySubReconciled = false;
  };

  const currentTracks = (): MediaTracks | undefined =>
    Array.isArray(rawTrackList)
      ? inspectMpvTracks(rawTrackList, aid, sid, secondarySid, manualVideoQualityId, program)
      : undefined;

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
      if (options?.programId === undefined) {
        programPref = undefined;
      } else {
        const parsed = parseProgramNumber(options.programId);
        programPref = parsed === undefined ? undefined : String(parsed);
      }

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

      if (options === undefined || options.secondarySubtitleTrackId === undefined) {
        secondarySubPref = { kind: 'default' };
      } else if (options.secondarySubtitleTrackId === null) {
        secondarySubPref = { kind: 'off' };
      } else if (
        secondarySubPref.kind !== 'selected' ||
        secondarySubPref.choice.id !== options.secondarySubtitleTrackId
      ) {
        secondarySubPref = {
          kind: 'selected',
          choice: { id: options.secondarySubtitleTrackId },
        };
      }
    },

    onRetryOrRecreate() {
      resetFileState();
    },

    onStop() {
      resetFileState();
      programPref = undefined;
      audioPref = undefined;
      subPref = { kind: 'default' };
      secondarySubPref = { kind: 'default' };
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
      else if (name === 'secondary-sid') secondarySid = value;
      else if (name === 'program') program = value;
      else if (name === 'vid') {
        if (value === 'auto' || value === false || value === 'no') manualVideoQualityId = null;
      } else return [];
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

    clearSecondaryIfCollides(primaryId) {
      if (primaryId === null) return undefined;
      const activeSecondary =
        currentTracks()?.selectedSecondarySubtitleId ??
        (typeof secondarySid === 'number' && Number.isInteger(secondarySid) && secondarySid > 0
          ? `s:${secondarySid}`
          : secondarySubPref.kind === 'selected'
            ? secondarySubPref.choice.id
            : null);
      if (activeSecondary !== primaryId) return undefined;
      secondarySubPref = { kind: 'off' };
      if (token !== undefined) secondarySubReconciled = true;
      return ['set_property', 'secondary-sid', 'no'];
    },

    selectSecondarySubtitle(id) {
      const cmd = parseSecondarySubtitleTrackCommand(id);
      if (!cmd) return undefined;
      const activePrimary =
        currentTracks()?.selectedSubtitleId ??
        (typeof sid === 'number' && Number.isInteger(sid) && sid > 0
          ? `s:${sid}`
          : subPref.kind === 'selected'
            ? subPref.choice.id
            : null);
      if (id !== null && activePrimary !== null && id === activePrimary) return undefined;
      if (id === null) {
        secondarySubPref = { kind: 'off' };
      } else {
        const matched = currentTracks()?.subtitles.find((t) => t.id === id);
        const prev = secondarySubPref.kind === 'selected' ? secondarySubPref.choice : undefined;
        secondarySubPref = { kind: 'selected', choice: toPreference(id, matched, prev) };
      }
      if (token !== undefined) secondarySubReconciled = true;
      return cmd;
    },

    hasActiveSecondarySubtitle() {
      if (secondarySubPref.kind === 'selected') return true;
      if (secondarySubPref.kind === 'off') return false;
      return typeof secondarySid === 'number' && Number.isInteger(secondarySid) && secondarySid > 0;
    },

    selectVideoQuality(id) {
      const cmd = parseVideoQualityCommand(id);
      if (!cmd) return undefined;
      manualVideoQualityId = id;
      return cmd;
    },

    selectProgram(id) {
      const cmd = parseProgramCommand(id);
      if (!cmd) return undefined;
      const num = parseProgramNumber(id);
      if (num === undefined) return undefined;
      programPref = String(num);
      manualVideoQualityId = null;
      if (token !== undefined) programReconciled = true;
      return cmd;
    },

    sync() {
      return emitIfChanged();
    },

    reconcileCommands() {
      if (programReconciled && audioReconciled && subReconciled && secondarySubReconciled) {
        return [];
      }
      const snapshot = currentTracks();
      const commands: MpvCommand[] = [];
      let effectiveSnapshot = snapshot;

      if (!programReconciled) {
        if (programPref === undefined) {
          if (snapshot) programReconciled = true;
        } else if (snapshot) {
          if (snapshot.programs && snapshot.programs.length > 1) {
            const matched = snapshot.programs.find((p) => p.id === programPref);
            if (matched) {
              programReconciled = true;
              if (snapshot.selectedProgramId !== matched.id) {
                const cmd = parseProgramCommand(matched.id);
                if (cmd) commands.push(cmd);
                effectiveSnapshot = { ...snapshot, selectedProgramId: matched.id };
              }
            }
          } else if (fileLoaded) {
            programReconciled = true;
          }
        }
      }

      const scoped =
        effectiveSnapshot === undefined ? undefined : filterTracksByProgram(effectiveSnapshot);
      let effectivePrimaryId: string | null = scoped?.selectedSubtitleId ?? null;

      if (!audioReconciled) {
        if (audioPref === undefined) {
          if (scoped) audioReconciled = true;
        } else if (scoped) {
          const resolved = resolveChoice(scoped.audio, audioPref);
          if (resolved) {
            audioReconciled = true;
            audioPref = toPreference(resolved.id, resolved, audioPref);
            if (scoped.selectedAudioId !== resolved.id) {
              const cmd = parseAudioTrackCommand(resolved.id);
              if (cmd) commands.push(cmd);
            }
          }
        }
      }

      if (!subReconciled) {
        if (subPref.kind === 'default') {
          if (scoped) subReconciled = true;
        } else if (subPref.kind === 'off') {
          effectivePrimaryId = null;
          if (sid === 'no' || sentSidNo) {
            subReconciled = true;
          } else if (fileLoaded || (scoped !== undefined && scoped.subtitles.length > 0)) {
            sentSidNo = true;
            subReconciled = true;
            commands.push(['set_property', 'sid', 'no']);
          }
        } else if (scoped) {
          const resolved = resolveChoice(scoped.subtitles, subPref.choice);
          if (resolved) {
            effectivePrimaryId = resolved.id;
            subReconciled = true;
            subPref = {
              kind: 'selected',
              choice: toPreference(resolved.id, resolved, subPref.choice),
            };
            if (scoped.selectedSubtitleId !== resolved.id) {
              const cmd = parseSubtitleTrackCommand(resolved.id);
              if (cmd) commands.push(cmd);
            }
          }
        }
      }

      if (!secondarySubReconciled) {
        if (secondarySubPref.kind === 'default') {
          if (scoped) secondarySubReconciled = true;
        } else if (secondarySubPref.kind === 'off') {
          if (secondarySid === 'no' || secondarySid === false) {
            secondarySubReconciled = true;
          } else if (fileLoaded || (scoped !== undefined && scoped.subtitles.length > 0)) {
            secondarySubReconciled = true;
            commands.push(['set_property', 'secondary-sid', 'no']);
          }
        } else if (scoped) {
          const resolved = resolveChoice(scoped.subtitles, secondarySubPref.choice);
          if (resolved) {
            secondarySubReconciled = true;
            if (resolved.id === effectivePrimaryId) {
              secondarySubPref = { kind: 'off' };
              if (scoped.selectedSecondarySubtitleId !== undefined) {
                commands.push(['set_property', 'secondary-sid', 'no']);
              }
            } else {
              secondarySubPref = {
                kind: 'selected',
                choice: toPreference(resolved.id, resolved, secondarySubPref.choice),
              };
              if (scoped.selectedSecondarySubtitleId !== resolved.id) {
                const cmd = parseSecondarySubtitleTrackCommand(resolved.id);
                if (cmd) commands.push(cmd);
              }
            }
          }
        }
      }

      return commands;
    },
  };
}
