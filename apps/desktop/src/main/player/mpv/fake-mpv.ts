import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMpvClient } from './client.ts';
import type { MpvCommand } from './codec.ts';
import { LineDecoder } from './codec.ts';
import type { MpvProcess } from './process.ts';

/** One timed step of a fake media, `afterMs` after its `loadfile` ran; entry ids are added by the fake. */
type FakeMpvStep = { afterMs: number } & (
  | { event: 'start-file' | 'file-loaded' | 'playback-restart' }
  | { event: 'end-file'; reason: string; fileError?: string }
  | { property: string; value: unknown }
  | { log: { prefix: string; level: string; text: string } }
);

/** What one URL plays in the fake. */
export type FakeMpvScript = readonly FakeMpvStep[];

/** A scripted mpv that speaks JSON IPC on a real `net.Server` (a named pipe on win32, a Unix socket elsewhere). */
export interface FakeMpv {
  /** Matches `MpvEngineDeps.spawn`: waits `spawnDelayMs` (abortable), then serves one connection. */
  spawn(args: readonly string[], signal: AbortSignal): Promise<MpvProcess>;
  /** Every command received, in order, across processes. */
  readonly sent: readonly MpvCommand[];
  /** Received commands and emitted file events in wire order (`> loadfile <url>`, `< end-file stop 1`). */
  readonly trace: readonly string[];
  readonly spawnArgs: readonly (readonly string[])[];
  readonly connections: number;
  /** Processes killed: by `kill()`, or by an abort while starting. */
  readonly killed: number;
  /** High-water mark of entries between `start-file` and `end-file`. */
  maxOpenEntries(): number;
  /** The process dies at once (an external kill). */
  crash(): void;
  /** The user quits mpv: `end-file reason=quit`, then a clean exit. */
  userQuit(): void;
  /** mpv stops answering and sending. */
  hang(): void;
  /** Sends a `client-message` event (what `script-message` in the bindings produces). */
  clientMessage(...args: string[]): void;
  spawnDelayMs: number;
  /** Delay before a command runs and is answered. */
  replyDelayMs: number;
  /** Delay between a stop or replace and the old entry's `end-file`. */
  endDelayMs: number;
  /** mpv 0.42.0 answers `loadfile` with `{ playlist_entry_id }`; false leaves it out. */
  entryIdInReply: boolean;
  dispose(): Promise<void>;
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

const LEVELS = ['fatal', 'error', 'warn', 'info', 'status', 'v', 'debug', 'trace'];
/** Per-file properties mpv resets when the next file starts. */
const PER_FILE: ReadonlyArray<[string, unknown]> = [
  ['vid', 'auto'],
  ['aid', 'auto'],
  ['sid', 'auto'],
  ['track-list', undefined],
  ['video-params', undefined],
  ['time-pos', undefined],
  ['duration', undefined],
];
/** Same reply timeout as `spawnMpv`. */
const REPLY_TIMEOUT_MS = 3000;

type Exit = { code: number | null; signal: string | null };

interface Media {
  id: number;
  started: boolean;
  timers: ReturnType<typeof setTimeout>[];
}

interface Proc {
  server: Server;
  path: string;
  socket?: Socket;
  observers: Array<{ id: number; name: string }>;
  props: Map<string, unknown>;
  logLevel?: string;
  nextEntryId: number;
  playlist: number[];
  media?: Media;
  hung: boolean;
  gone: boolean;
  exited: Promise<Exit>;
  finish(info: Exit): void;
}

const abortError = (): Error =>
  Object.assign(new Error('mpv launch aborted'), { name: 'AbortError' });

const endpoint = (): string => {
  const name = `elv-fake-mpv-${randomBytes(8).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
};

/** Creates the fake; `transport: 'socket'` is the only transport it serves. */
export function createFakeMpv(opts: {
  scripts: Record<string, FakeMpvScript>;
  transport: 'socket';
}): FakeMpv {
  const sent: MpvCommand[] = [];
  const trace: string[] = [];
  const spawnArgs: string[][] = [];
  const procs: Proc[] = [];
  let connections = 0;
  let killed = 0;
  let open = 0;
  let maxOpen = 0;
  let nextPid = 7000;

  const latest = (): Proc | undefined => procs.at(-1);

  const write = (p: Proc, message: Record<string, unknown>): void => {
    if (p.gone || p.hung || !p.socket || p.socket.destroyed) return;
    const event = message['event'];
    if (typeof event === 'string' && event !== 'property-change' && event !== 'log-message') {
      const parts = [event, message['reason'], message['playlist_entry_id']];
      trace.push(`< ${parts.filter((x) => x !== undefined).join(' ')}`);
    }
    p.socket.write(`${JSON.stringify(message)}\n`);
  };

  const later = (p: Proc, fn: () => void, ms: number): void => {
    if (ms <= 0) fn();
    else setTimeout(() => !p.gone && fn(), ms);
  };

  const setProp = (p: Proc, name: string, value: unknown): void => {
    if (JSON.stringify(p.props.get(name)) === JSON.stringify(value)) return;
    p.props.set(name, value);
    for (const o of p.observers) {
      if (o.name !== name) continue;
      write(p, {
        event: 'property-change',
        id: o.id,
        name,
        ...(value === undefined ? {} : { data: value }),
      });
    }
  };

  /** Ends the current media now (`end-file` only if it had started) and cancels its script. */
  const endMedia = (p: Proc, reason: string, fileError?: string): void => {
    const media = p.media;
    if (!media) return;
    for (const t of media.timers) clearTimeout(t);
    p.media = undefined;
    if (!media.started) return;
    open -= 1;
    write(p, {
      event: 'end-file',
      reason,
      ...(fileError === undefined ? {} : { file_error: fileError }),
      playlist_entry_id: media.id,
    });
  };

  /** Cancels the current media's script and sends its `end-file` after `endDelayMs`. */
  const endLater = (p: Proc, then: () => void): void => {
    const media = p.media;
    if (media) for (const t of media.timers) clearTimeout(t);
    p.media = undefined;
    later(
      p,
      () => {
        if (media?.started) {
          open -= 1;
          write(p, { event: 'end-file', reason: 'stop', playlist_entry_id: media.id });
        }
        then();
      },
      media ? fake.endDelayMs : 0,
    );
  };

  const runStep = (p: Proc, media: Media, step: FakeMpvStep): void => {
    if (p.media !== media || p.gone || p.hung) return;
    if ('property' in step) setProp(p, step.property, step.value);
    else if ('log' in step) {
      const wanted = p.logLevel === undefined ? -1 : LEVELS.indexOf(p.logLevel);
      if (LEVELS.indexOf(step.log.level) <= wanted) write(p, { event: 'log-message', ...step.log });
    } else if (step.event === 'start-file') {
      media.started = true;
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      write(p, { event: 'start-file', playlist_entry_id: media.id });
      for (const [name, value] of PER_FILE) setProp(p, name, value);
    } else if (step.event === 'end-file') {
      endMedia(p, step.reason, step.fileError);
      p.playlist = [];
    } else write(p, { event: step.event });
  };

  const exit = (p: Proc, info: Exit, graceful: boolean): void => {
    if (p.gone) return;
    if (p.media) for (const t of p.media.timers) clearTimeout(t);
    if (p.media?.started) open -= 1;
    p.media = undefined;
    p.gone = true;
    if (graceful) p.socket?.end();
    else p.socket?.destroy();
    p.server.close();
    if (process.platform !== 'win32') rmSync(p.path, { force: true });
    p.finish(info);
  };

  const quit = (p: Proc): void => {
    endMedia(p, 'quit');
    exit(p, { code: 0, signal: null }, true);
  };

  const execute = (p: Proc, command: MpvCommand, requestId: number): void => {
    const reply = (extra: Record<string, unknown> = {}): void =>
      write(p, { request_id: requestId, error: 'success', data: null, ...extra });
    const fail = (error: string): void => write(p, { request_id: requestId, error });
    const [name, ...args] = command;
    switch (name) {
      case 'observe_property': {
        const [id, prop] = [Number(args[0]), String(args[1])];
        p.observers.push({ id, name: prop });
        reply();
        const value = p.props.get(prop);
        write(p, {
          event: 'property-change',
          id,
          name: prop,
          ...(value === undefined ? {} : { data: value }),
        });
        return;
      }
      case 'request_log_messages':
        p.logLevel = String(args[0]);
        reply();
        return;
      case 'loadfile': {
        const id = ++p.nextEntryId;
        p.playlist = [id];
        reply(fake.entryIdInReply ? { data: { playlist_entry_id: id } } : {});
        const steps = opts.scripts[String(args[0])] ?? FAKE_PLAYING;
        endLater(p, () => {
          const media: Media = { id, started: false, timers: [] };
          p.media = media;
          for (const step of steps)
            media.timers.push(setTimeout(() => runStep(p, media, step), step.afterMs));
        });
        return;
      }
      case 'get_property': {
        const prop = String(args[0]);
        const value = prop === 'playlist/0/id' ? p.playlist[0] : p.props.get(prop);
        if (value === undefined) fail('property unavailable');
        else reply({ data: value });
        return;
      }
      case 'set':
      case 'set_property': {
        const raw = args[1];
        setProp(p, String(args[0]), raw === 'yes' ? true : raw === 'no' ? false : raw);
        reply();
        return;
      }
      case 'seek': {
        const media = p.media;
        if (!media?.started) {
          fail('error running command');
          return;
        }
        reply();
        setProp(p, 'seeking', true);
        media.timers.push(
          setTimeout(() => {
            if (p.media !== media) return;
            setProp(p, 'time-pos', Number(args[0]));
            setProp(p, 'seeking', false);
            write(p, { event: 'playback-restart' });
          }, 2),
        );
        return;
      }
      case 'stop':
        reply();
        p.playlist = [];
        endLater(p, () => write(p, { event: 'idle' }));
        return;
      case 'quit':
        reply();
        quit(p);
        return;
      default:
        reply();
    }
  };

  const listen = async (): Promise<Proc> => {
    const server = createServer();
    let finish: (info: Exit) => void = () => undefined;
    const exited = new Promise<Exit>((resolve) => {
      finish = resolve;
    });
    const p: Proc = {
      server,
      path: endpoint(),
      observers: [],
      props: new Map<string, unknown>([
        ['pause', false],
        ['core-idle', true],
        ['speed', 1],
        ['vid', 'auto'],
        ['aid', 'auto'],
        ['sid', 'auto'],
      ]),
      nextEntryId: 0,
      playlist: [],
      hung: false,
      gone: false,
      exited,
      finish: (info) => finish(info),
    };
    server.on('connection', (socket) => {
      connections += 1;
      p.socket = socket;
      socket.on('error', () => undefined);
      const decoder = new LineDecoder();
      socket.on('data', (chunk: Buffer) => {
        for (const message of decoder.push(chunk) as unknown as Array<Record<string, unknown>>) {
          const command = message['command'];
          if (!Array.isArray(command) || p.gone) continue;
          const cmd = command as MpvCommand;
          sent.push(cmd);
          trace.push(`> ${cmd.filter((c) => typeof c !== 'object').join(' ')}`);
          if (p.hung) continue;
          later(p, () => execute(p, cmd, Number(message['request_id'])), fake.replyDelayMs);
        }
      });
      socket.on('close', () => exit(p, { code: 1, signal: null }, false));
    });
    await new Promise<void>((resolve) => server.listen(p.path, resolve));
    return p;
  };

  const toProcess = async (p: Proc): Promise<MpvProcess> => {
    const socket = connect(p.path);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const client = createMpvClient(socket, { replyTimeoutMs: REPLY_TIMEOUT_MS });
    const kill = (): void => {
      if (!p.gone) killed += 1;
      exit(p, { code: null, signal: 'SIGKILL' }, false);
      client.close();
    };
    return {
      pid: nextPid++,
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
  };

  const fake: FakeMpv = {
    async spawn(args, signal) {
      spawnArgs.push([...args]);
      if (signal.aborted) {
        killed += 1;
        throw abortError();
      }
      if (fake.spawnDelayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            clearTimeout(timer);
            killed += 1;
            reject(abortError());
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, fake.spawnDelayMs);
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      const p = await listen();
      procs.push(p);
      return toProcess(p);
    },
    sent,
    trace,
    spawnArgs,
    get connections() {
      return connections;
    },
    get killed() {
      return killed;
    },
    maxOpenEntries: () => maxOpen,
    crash() {
      const p = latest();
      if (p) exit(p, { code: 1, signal: null }, false);
    },
    userQuit() {
      const p = latest();
      if (p && !p.gone) quit(p);
    },
    hang() {
      const p = latest();
      if (!p) return;
      p.hung = true;
      if (p.media) for (const t of p.media.timers) clearTimeout(t);
    },
    clientMessage(...args) {
      const p = latest();
      if (p) write(p, { event: 'client-message', args });
    },
    spawnDelayMs: 0,
    replyDelayMs: 0,
    endDelayMs: 0,
    entryIdInReply: true,
    async dispose() {
      for (const p of procs) exit(p, { code: null, signal: 'SIGKILL' }, false);
      await Promise.all(
        procs.map((p) => new Promise<void>((resolve) => p.server.close(() => resolve()))),
      );
    },
  };
  return fake;
}
