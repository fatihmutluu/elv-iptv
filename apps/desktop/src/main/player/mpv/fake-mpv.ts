import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MpvCommand } from './codec.ts';
import { LineDecoder } from './codec.ts';
import {
  connectFakeProcess,
  FAKE_PLAYING,
  type FakeExit,
  type FakeMedia,
  type FakeMpvScript,
  type FakeMpvStep,
  type FakeProc,
  fakeHttpError,
  parseResetOnNextFile,
  RESETTABLE_PROPS,
  STREAM_INTRINSIC_PROPS,
  scheduleFakeScript,
  syncTrackSelection,
} from './fake-mpv-proc.ts';
import type { MpvProcess } from './process.ts';

export { FAKE_PLAYING, type FakeMpvScript, fakeHttpError };

/** A scripted mpv that speaks JSON IPC on a real `net.Server` (a named pipe on win32, a Unix socket elsewhere). */
export interface FakeMpv {
  spawn(args: readonly string[], signal: AbortSignal): Promise<MpvProcess>;
  readonly sent: readonly MpvCommand[];
  readonly trace: readonly string[];
  readonly spawnArgs: readonly (readonly string[])[];
  readonly connections: number;
  readonly killed: number;
  maxOpenEntries(): number;
  crash(): void;
  userQuit(): void;
  hang(): void;
  clientMessage(...args: string[]): void;
  spawnDelayMs: number;
  replyDelayMs: number;
  endDelayMs: number;
  entryIdInReply: boolean;
  dispose(): Promise<void>;
}

const LEVELS = ['fatal', 'error', 'warn', 'info', 'status', 'v', 'debug', 'trace'];
const REPLY_TIMEOUT_MS = 3000;

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
  const procs: FakeProc[] = [];
  let connections = 0;
  let killed = 0;
  let open = 0;
  let maxOpen = 0;
  let nextPid = 7000;

  const latest = (): FakeProc | undefined => procs.at(-1);

  const write = (p: FakeProc, message: Record<string, unknown>): void => {
    if (p.gone || p.hung || !p.socket || p.socket.destroyed) return;
    const event = message['event'];
    if (typeof event === 'string' && event !== 'property-change' && event !== 'log-message') {
      const parts = [event, message['reason'], message['playlist_entry_id']];
      trace.push(`< ${parts.filter((x) => x !== undefined).join(' ')}`);
    }
    p.socket.write(`${JSON.stringify(message)}\n`);
  };

  const later = (p: FakeProc, fn: () => void, ms: number): void => {
    if (ms <= 0) fn();
    else setTimeout(() => !p.gone && fn(), ms);
  };

  const setProp = (p: FakeProc, name: string, value: unknown): void => {
    const resolved = name === 'track-list' ? syncTrackSelection(p, value) : value;
    if (JSON.stringify(p.props.get(name)) === JSON.stringify(resolved)) return;
    p.props.set(name, resolved);
    for (const o of p.observers) {
      if (o.name !== name) continue;
      write(p, {
        event: 'property-change',
        id: o.id,
        name,
        ...(resolved === undefined ? {} : { data: resolved }),
      });
    }
  };

  const endMedia = (p: FakeProc, reason: string, fileError?: string): void => {
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

  const endLater = (p: FakeProc, then: () => void): void => {
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

  const runStep = (p: FakeProc, media: FakeMedia, step: FakeMpvStep): void => {
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
      for (const [name, value] of STREAM_INTRINSIC_PROPS) setProp(p, name, value);
      for (const [name, value] of RESETTABLE_PROPS) {
        if (p.resetOnNextFile.has('all') || p.resetOnNextFile.has(name)) {
          setProp(p, name, value);
        }
      }
    } else if (step.event === 'end-file') {
      endMedia(p, step.reason, step.fileError);
      p.playlist = [];
    } else write(p, { event: step.event });
  };

  const exit = (p: FakeProc, info: FakeExit, graceful: boolean): void => {
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

  const execute = (p: FakeProc, command: MpvCommand, requestId: number): void => {
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
          const media: FakeMedia = { id, started: false, timers: [] };
          p.media = media;
          scheduleFakeScript(p, media, steps, runStep);
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
      case 'cycle': {
        const prop = String(args[0]);
        setProp(p, prop, !(p.props.get(prop) === true));
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
        endMedia(p, 'quit');
        exit(p, { code: 0, signal: null }, true);
        return;
      default:
        reply();
    }
  };

  const listen = async (resetOnNextFile: ReadonlySet<string>): Promise<FakeProc> => {
    const server = createServer();
    let finish: (info: FakeExit) => void = () => undefined;
    const exited = new Promise<FakeExit>((resolve) => {
      finish = resolve;
    });
    const p: FakeProc = {
      server,
      path: endpoint(),
      observers: [],
      props: new Map<string, unknown>([
        ['pause', false],
        ['core-idle', true],
        ['speed', 1],
        ['deinterlace', 'no'],
        ['video-aspect-override', '-1'],
        ['audio-delay', 0],
        ['sub-delay', 0],
        ['vid', 'auto'],
        ['aid', 'auto'],
        ['sid', 'auto'],
        ['volume', 100],
        ['mute', false],
      ]),
      resetOnNextFile,
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
      const p = await listen(parseResetOnNextFile(args));
      procs.push(p);
      return connectFakeProcess(p, nextPid++, REPLY_TIMEOUT_MS, () => {
        if (!p.gone) killed += 1;
        exit(p, { code: null, signal: 'SIGKILL' }, false);
      });
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
      if (p && !p.gone) {
        endMedia(p, 'quit');
        exit(p, { code: 0, signal: null }, true);
      }
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
