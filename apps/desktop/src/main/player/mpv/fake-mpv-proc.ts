import { connect, type Server, type Socket } from 'node:net';
import { createMpvClient } from './client.ts';
import type { MpvProcess } from './process.ts';

/** One timed step of a fake media, `afterMs` after its `loadfile` ran; entry ids are added by the fake. */
export type FakeMpvStep = { afterMs: number } & (
  | { event: 'start-file' | 'file-loaded' | 'playback-restart' }
  | { event: 'end-file'; reason: string; fileError?: string }
  | { property: string; value: unknown }
  | { log: { prefix: string; level: string; text: string } }
);

/** What one URL plays in the fake. */
export type FakeMpvScript = readonly FakeMpvStep[];

/** Exit summary of a fake mpv process. */
export type FakeExit = { code: number | null; signal: string | null };

/** Active fake media playback entry. */
export interface FakeMedia {
  id: number;
  started: boolean;
  timers: ReturnType<typeof setTimeout>[];
}

/** One simulated mpv server instance. */
export interface FakeProc {
  server: Server;
  path: string;
  socket?: Socket;
  observers: Array<{ id: number; name: string }>;
  props: Map<string, unknown>;
  resetOnNextFile: ReadonlySet<string>;
  logLevel?: string;
  nextEntryId: number;
  playlist: number[];
  media?: FakeMedia;
  hung: boolean;
  gone: boolean;
  exited: Promise<FakeExit>;
  finish(info: FakeExit): void;
}

/** A video media that plays: opening, buffering, video, first restart, then a few positions. */
export const FAKE_PLAYING: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 3, event: 'file-loaded' },
  { afterMs: 3, property: 'vid', value: 1 },
  { afterMs: 5, property: 'video-params', value: { w: 1280, h: 720 } },
  { afterMs: 8, property: 'time-pos', value: 0 },
  { afterMs: 8, event: 'playback-restart' },
  { afterMs: 8, property: 'core-idle', value: false },
  { afterMs: 15, property: 'time-pos', value: 0.04 },
];

/** A stream the server answers with an HTTP error, logged as the pinned runtime logs it. */
export function fakeHttpError(status: number, reason: string): FakeMpvScript {
  return [
    { afterMs: 0, event: 'start-file' },
    {
      afterMs: 4,
      log: { prefix: 'ffmpeg', level: 'warn', text: `http: HTTP error ${status} ${reason}` },
    },
    { afterMs: 5, log: { prefix: 'stream', level: 'error', text: 'Failed to open the stream.' } },
    { afterMs: 6, event: 'end-file', reason: 'error', fileError: 'loading failed' },
  ];
}

/** Extracts `--reset-on-next-file=...` property names passed to `spawn`. */
export function parseResetOnNextFile(args: readonly string[]): Set<string> {
  const out = new Set<string>();
  const prefix = '--reset-on-next-file=';
  for (const arg of args) {
    if (!arg.startsWith(prefix)) continue;
    for (const item of arg.slice(prefix.length).split(',')) {
      const trimmed = item.trim();
      if (trimmed) out.add(trimmed);
    }
  }
  return out;
}

/** Recomputes `selected` flags on `track-list` entries from the active `aid`/`sid` properties. */
export function syncTrackSelection(p: FakeProc, rawList: unknown): unknown {
  if (!Array.isArray(rawList)) return rawList;
  const curAid = p.props.get('aid');
  const curSid = p.props.get('sid');
  return rawList.map((item) => {
    if (typeof item !== 'object' || item === null) return item;
    const rec = item as Record<string, unknown>;
    if (rec['type'] === 'audio' && curAid !== 'auto') {
      return { ...rec, selected: typeof curAid === 'number' && rec['id'] === curAid };
    }
    if (rec['type'] === 'sub' && curSid !== 'auto') {
      return { ...rec, selected: typeof curSid === 'number' && rec['id'] === curSid };
    }
    return item;
  });
}

/** Connects an `MpvClient` to a running `FakeProc` server and wraps it as an `MpvProcess`. */
export async function connectFakeProcess(
  p: FakeProc,
  pid: number,
  replyTimeoutMs: number,
  onKill: () => void,
): Promise<MpvProcess> {
  const socket = connect(p.path);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const client = createMpvClient(socket, { replyTimeoutMs });
  const kill = (): void => {
    onKill();
    client.close();
  };
  return {
    pid,
    client,
    exited: p.exited,
    async quit(graceMs = 1000) {
      client.command(['quit']).catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = await Promise.race([
        p.exited.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), graceMs);
        }),
      ]);
      clearTimeout(timer);
      if (late) kill();
      client.close();
    },
    kill,
  };
}
