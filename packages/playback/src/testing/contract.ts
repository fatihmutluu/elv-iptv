import type { EngineEvent, LoadCommand, PlayerEngine } from '../engine';

/** What a contract run needs from one engine under test; the engine's own test file builds it. */
export interface EngineContractHarness {
  readonly engine: PlayerEngine;
  /** `plays` and `playsToo` reach `playing`; `notFound` ends in `http-404`. */
  readonly urls: { readonly plays: string; readonly playsToo: string; readonly notFound: string };
  /** Runs the engine's time and I/O until it is quiet (fake: advance 1,000 ms; real: no event for 100 ms, at most 3,000 ms). */
  settle(): Promise<void>;
  /** High-water mark of simultaneously open medias; must stay 1. */
  maxConcurrentMedias(): number;
  dispose(): Promise<void>;
}

/** One behavior every engine must show; throws `Error('contract: <name>: <what>')` on a violation. */
export interface EngineContractCase {
  readonly name: string;
  run(h: EngineContractHarness): Promise<void>;
}

function check(name: string, ok: boolean, what: string): void {
  if (!ok) throw new Error(`contract: ${name}: ${what}`);
}

function loadCmd(url: string, attempt: number): LoadCommand {
  return { url, headers: {}, attempt, kind: 'live' };
}

function record(h: EngineContractHarness): { events: EngineEvent[]; stop: () => void } {
  const events: EngineEvent[] = [];
  const stop = h.engine.subscribe((e) => events.push(e));
  return { events, stop };
}

function hasState(events: readonly EngineEvent[], attempt: number, state: string): boolean {
  return events.some((e) => e.attempt === attempt && e.type === 'state' && e.state === state);
}

function defineCase(name: string, run: EngineContractCase['run']): EngineContractCase {
  return { name, run };
}

/** The shared engine contract (spec section 5.1); every engine's test file runs all of these. */
export const ENGINE_CONTRACT_CASES: readonly EngineContractCase[] = [
  defineCase('load reports opening, firstFrame and playing with its token', async (h) => {
    const name = 'load reports opening, firstFrame and playing with its token';
    const { events } = record(h);
    h.engine.load(loadCmd(h.urls.plays, 4));
    await h.settle();
    check(
      name,
      events.length > 0 && events.every((e) => e.attempt === 4),
      'every event carries token 4',
    );
    check(name, hasState(events, 4, 'opening'), 'no opening state');
    check(
      name,
      events.some((e) => e.type === 'firstFrame'),
      'no firstFrame',
    );
    check(name, hasState(events, 4, 'playing'), 'no playing state');
    const frame = events.findIndex((e) => e.type === 'firstFrame');
    const playing = events.findIndex((e) => e.type === 'state' && e.state === 'playing');
    check(name, frame < playing, 'firstFrame must come before playing');
  }),

  defineCase('a newer load replaces the media and never holds two', async (h) => {
    const name = 'a newer load replaces the media and never holds two';
    const { events } = record(h);
    h.engine.load(loadCmd(h.urls.plays, 1));
    h.engine.load(loadCmd(h.urls.playsToo, 2));
    const mark = events.length;
    await h.settle();
    check(name, h.maxConcurrentMedias() === 1, 'two medias were open at once');
    check(name, hasState(events, 2, 'playing'), 'the newer media never played');
    check(
      name,
      events.slice(mark).every((e) => e.attempt === 2),
      'the replaced media emitted after the newer load',
    );
  }),

  defineCase('pause and play adopt the newer token for the current media', async (h) => {
    const name = 'pause and play adopt the newer token for the current media';
    const { events } = record(h);
    h.engine.load(loadCmd(h.urls.plays, 1));
    await h.settle();
    let mark = events.length;
    h.engine.pause(2);
    await h.settle();
    const afterPause = events.slice(mark);
    check(
      name,
      afterPause.every((e) => e.attempt === 2),
      'events after pause kept the old token',
    );
    mark = events.length;
    h.engine.play(3);
    await h.settle();
    const afterPlay = events.slice(mark);
    check(
      name,
      afterPlay.every((e) => e.attempt === 3),
      'events after play kept the old token',
    );
    check(name, h.maxConcurrentMedias() === 1, 'pause or play opened another media');
  }),

  defineCase('a missing stream ends in http-404 with the load token', async (h) => {
    const name = 'a missing stream ends in http-404 with the load token';
    const { events } = record(h);
    h.engine.load(loadCmd(h.urls.notFound, 9));
    await h.settle();
    const failure = events.find((e) => e.type === 'error');
    check(name, failure !== undefined, 'no error event');
    check(name, failure?.attempt === 9, 'the error does not carry token 9');
    check(
      name,
      failure?.type === 'error' && failure.error.code === 'http-404',
      'the error code is not http-404',
    );
  }),

  defineCase('stop silences the stopped media', async (h) => {
    const name = 'stop silences the stopped media';
    const { events } = record(h);
    h.engine.load(loadCmd(h.urls.plays, 1));
    await h.settle();
    h.engine.stop(2);
    const mark = events.length;
    await h.settle();
    check(name, events.length === mark, 'events arrived after stop');
  }),

  defineCase('clock anchors pause at rate 0', async (h) => {
    const name = 'clock anchors pause at rate 0';
    const { events } = record(h);
    h.engine.load(loadCmd(h.urls.plays, 1));
    await h.settle();
    const mark = events.length;
    h.engine.pause(2);
    await h.settle();
    const anchor = events.slice(mark).find((e) => e.type === 'clock');
    check(name, anchor !== undefined, 'pause produced no clock anchor');
    if (anchor?.type === 'clock') {
      check(name, anchor.anchor.rate === 0, 'the pause anchor is not at rate 0');
      check(name, anchor.anchor.positionMs >= 0, 'the pause anchor has a negative position');
    }
  }),

  defineCase('unsubscribe stops delivery', async (h) => {
    const name = 'unsubscribe stops delivery';
    const { events, stop } = record(h);
    h.engine.load(loadCmd(h.urls.plays, 1));
    await h.settle();
    check(name, events.length > 0, 'nothing was delivered before unsubscribe');
    stop();
    const mark = events.length;
    h.engine.load(loadCmd(h.urls.playsToo, 2));
    await h.settle();
    check(name, events.length === mark, 'events arrived after unsubscribe');
  }),

  defineCase('commands after release never throw and emit nothing', async (h) => {
    const name = 'commands after release never throw and emit nothing';
    const { events } = record(h);
    h.engine.load(loadCmd(h.urls.plays, 1));
    await h.settle();
    h.engine.release();
    const mark = events.length;
    try {
      h.engine.load(loadCmd(h.urls.plays, 2));
      h.engine.retry(3);
      h.engine.play(4);
      h.engine.pause(5);
      h.engine.seek(6, 1000);
      h.engine.selectAudioTrack?.(7, 'a:0');
      h.engine.selectSubtitleTrack?.(8, null);
      h.engine.recreate(9);
      h.engine.stop(10);
      h.engine.release();
      await h.settle();
    } catch (error) {
      throw new Error(`contract: ${name}: a command threw (${String(error)})`);
    }
    check(name, events.length === mark, 'events arrived after release');
  }),
];
