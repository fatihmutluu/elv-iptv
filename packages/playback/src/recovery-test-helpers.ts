import { ok } from '@elv/domain';
import { vi } from 'vitest';
import type {
  EngineCapabilities,
  EngineErrorCode,
  EngineState,
  LoadCommand,
  StreamRequest,
} from './engine';
import { createPlaybackService } from './service';
import { createFakePlayerEngine, type FakePlayerEngine, type FakeStep } from './testing';
import type { PlaybackService, PlaybackStatus, TuneRequest } from './types';

/** A service over a fake engine whose `load` calls are recorded with their time. */
export interface Rig {
  engine: FakePlayerEngine;
  service: PlaybackService;
  loads: LoadCommand[];
  loadAt: number[];
}

/** Builds a {@link Rig} on Vitest fake timers. */
export function rig(
  scripts: Record<string, readonly FakeStep[]>,
  capabilities: Partial<EngineCapabilities> = {},
): Rig {
  const engine = createFakePlayerEngine({
    scripts,
    capabilities,
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const loads: LoadCommand[] = [];
  const loadAt: number[] = [];
  const load = engine.load.bind(engine);
  vi.spyOn(engine, 'load').mockImplementation((cmd) => {
    loads.push(cmd);
    loadAt.push(Date.now());
    load(cmd);
  });
  const service = createPlaybackService({
    engine,
    clock: { now: () => Date.now() },
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
  });
  return { engine, service, loads, loadAt };
}

export const req = (url: string): StreamRequest => ({ url, headers: {} });
export const resolved = (url: string) => () => Promise.resolve(ok(req(url)));
export const live = (url: string, extra: Partial<TuneRequest> = {}): TuneRequest => ({
  item: url,
  accountKey: 'acc',
  kind: 'live',
  resolve: resolved(url),
  ...extra,
});
export const vod = (url: string, extra: Partial<TuneRequest> = {}): TuneRequest =>
  live(url, { kind: 'vod', ...extra });
export const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
export const status = (r: Rig): PlaybackStatus => r.service.getState().status;
const token = (r: Rig) => r.service.getState().attempt;
export const last = (r: Rig) => r.engine.commands.at(-1);
export const state = (r: Rig, s: EngineState) =>
  r.engine.emit({ attempt: token(r), type: 'state', state: s });
export const play = (r: Rig) => {
  r.engine.emit({ attempt: token(r), type: 'firstFrame', atMs: Date.now() });
  state(r, 'playing');
};
export const stall = (r: Rig, phase: 'start' | 'end') =>
  r.engine.emit({ attempt: token(r), type: 'stall', phase, atMs: Date.now() });
export const error = (r: Rig, code: EngineErrorCode) =>
  r.engine.emit({ attempt: token(r), type: 'error', error: { code } });
export const recovering = (rung: 1 | 2 | 3 | 4, inMs: number): PlaybackStatus => ({
  kind: 'recovering',
  rung,
  nextAtMs: Date.now() + inMs,
});
export const failed = (code: string): PlaybackStatus => ({
  kind: 'failed',
  error: { category: 'playback', code },
});
export const errorAt = (afterMs: number, code: EngineErrorCode): FakeStep => ({
  afterMs,
  emit: 'error',
  error: { code },
});

export async function playing(r: Rig, request: TuneRequest): Promise<number> {
  const t = r.service.tune(request);
  await tick(0);
  play(r);
  return t;
}
