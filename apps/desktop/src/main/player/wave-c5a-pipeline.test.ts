import type { EngineEvent } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerUiEvent } from '../../shared/player-ipc.ts';
import { createMpvEngine, type MpvEngineDeps } from './engine.ts';
import { DEINTERLACE_BWDIF_FILTER, LOUDNORM_FILTER } from './engine-controls.ts';
import { playing, setupEngineTest, sleep, states } from './engine-test-helpers.ts';
import { createFakeMpv, type FakeMpvScript } from './mpv/fake-mpv.ts';
import { LAUNCH_OPTIONS } from './mpv/options.ts';
import type { VideoPresenter } from './presenter/types.ts';

const URL_EP1 = 'http://sim.test/series/demo/demo/s01e01.mkv';
const URL_EP2 = 'http://sim.test/series/demo/demo/s01e02.mkv';
const URL_EP3 = 'http://sim.test/series/demo/demo/s02e01.mkv';
const URL_LIVE = 'http://sim.test/live/demo/demo/1001.ts';

const EP1_EOF: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 3, event: 'file-loaded' },
  { afterMs: 4, property: 'duration', value: 1200 },
  { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
  { afterMs: 6, property: 'time-pos', value: 1199 },
  { afterMs: 7, event: 'playback-restart' },
  { afterMs: 45, event: 'end-file', reason: 'eof' },
];

const EP2_PLAYING: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 3, event: 'file-loaded' },
  { afterMs: 4, property: 'duration', value: 1350 },
  { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
  { afterMs: 6, property: 'time-pos', value: 0 },
  { afterMs: 7, event: 'playback-restart' },
];

const EP_HOLD: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 3, event: 'file-loaded' },
  { afterMs: 4, property: 'duration', value: 1200 },
  { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
  { afterMs: 6, property: 'time-pos', value: 1 },
  { afterMs: 7, event: 'playback-restart' },
];

const timers: MpvEngineDeps['timers'] = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function stubPresenter(): VideoPresenter {
  return {
    kind: 'canvas',
    coversArea: false,
    prepare: async () => [],
    attach: () => undefined,
    setArea: () => undefined,
    toggleFullscreen: () => undefined,
    onEvent: () => () => undefined,
    dispose: () => undefined,
  };
}

describe('Wave C5A #243: mpv deinterlaceMode, scaletempo2 pitchLock, and labeled loudnorm', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  it('sends exact labeled vf/af and audio-pitch-correction commands without using set_property af', async () => {
    const { engine, fake, events } = await setupEngineTest(cleanups, {
      scripts: { [URL_EP1]: EP_HOLD },
    });
    engine.load({ attempt: 1, url: URL_EP1, headers: {}, kind: 'vod' });
    await playing(events, 1);

    engine.setDeinterlaceMode('auto');
    engine.setDeinterlaceMode('bwdif');
    engine.setDeinterlaceMode('off');
    engine.setPitchLock(false);
    engine.setPitchLock(1, true);
    engine.setAudioNormalization(true);
    engine.setAudioNormalization(false);

    await vi.waitFor(() => expect(fake.sent).toContainEqual(['af', 'remove', '@elv_loudnorm']));

    expect(fake.sent).toContainEqual(['set_property', 'deinterlace', 'auto']);
    expect(fake.sent).toContainEqual(['vf', 'remove', '@elv_deint']);
    expect(fake.sent).toContainEqual(['set_property', 'deinterlace', 'no']);
    expect(DEINTERLACE_BWDIF_FILTER).toContain('bwdif=mode=send_field');
    expect(fake.sent).toContainEqual(['vf', 'add', DEINTERLACE_BWDIF_FILTER]);
    expect(fake.sent).toContainEqual(['set_property', 'audio-pitch-correction', 'no']);
    expect(fake.sent).toContainEqual(['set_property', 'audio-pitch-correction', 'yes']);
    expect(fake.sent).toContainEqual(['af', 'add', LOUDNORM_FILTER]);
    expect(fake.sent).toContainEqual(['af', 'remove', '@elv_loudnorm']);

    // NEVER clobber unrelated af filters (e.g. @ac3:lavcac3enc) with set_property af!
    expect(fake.sent.some((c) => c[0] === 'set_property' && c[1] === 'af')).toBe(false);
    expect(fake.sent.some((c) => c[0] === 'set_property' && c[1] === 'vf')).toBe(false);
  });

  it('suppresses @elv_loudnorm while S/PDIF/HDMI bitstream passthrough is active', async () => {
    const { engine, fake, events } = await setupEngineTest(cleanups, {
      baseArgs: [...LAUNCH_OPTIONS, '--audio-spdif=ac3,eac3,dts-hd'],
      scripts: { [URL_EP1]: EP_HOLD },
    });
    engine.load({ attempt: 1, url: URL_EP1, headers: {}, kind: 'vod' });
    await playing(events, 1);

    engine.setAudioNormalization(true);
    await sleep(30);
    expect(fake.sent).not.toContainEqual(['af', 'add', LOUDNORM_FILTER]);

    // Recreate still respects passthrough suppression
    const beforeRecreate = fake.sent.length;
    engine.recreate(2);
    await vi.waitFor(() =>
      expect(fake.sent.slice(beforeRecreate)).toContainEqual(['request_log_messages', 'v']),
    );
    await sleep(20);
    expect(fake.sent.slice(beforeRecreate)).not.toContainEqual(['af', 'add', LOUDNORM_FILTER]);
  });

  it('persists deinterlaceMode, pitchLock, and audioNormalization across spawn, load(), and recreate()', async () => {
    const fake = createFakeMpv({ scripts: { [URL_EP1]: EP_HOLD }, transport: 'socket' });
    let releaseFirstSpawn: (() => void) | undefined;
    let spawnCount = 0;

    const engine = createMpvEngine({
      spawn: async (args, signal) => {
        spawnCount += 1;
        if (spawnCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstSpawn = resolve;
          });
        }
        return fake.spawn(args, signal);
      },
      presenter: stubPresenter(),
      baseArgs: LAUNCH_OPTIONS,
      loadMode: 'replace',
      now: () => Date.now(),
      timers,
      onUi: () => undefined,
      deferStart: true,
    });
    cleanups.push(async () => {
      engine.release();
      await fake.dispose();
    });

    engine.start();
    await vi.waitFor(() => expect(releaseFirstSpawn).toBeDefined());
    engine.setDeinterlaceMode('bwdif');
    engine.setPitchLock(false);
    engine.setAudioNormalization(true);
    releaseFirstSpawn?.();

    await vi.waitFor(() => {
      expect(DEINTERLACE_BWDIF_FILTER).toContain('bwdif=mode=send_field');
      expect(fake.sent).toContainEqual(['vf', 'add', DEINTERLACE_BWDIF_FILTER]);
      expect(fake.sent).toContainEqual(['set_property', 'audio-pitch-correction', 'no']);
      expect(fake.sent).toContainEqual(['af', 'add', LOUDNORM_FILTER]);
    });

    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    engine.load({ attempt: 1, url: URL_EP1, headers: {}, kind: 'vod' });
    await playing(events, 1);

    const beforeRecreate = fake.sent.length;
    engine.recreate(2);
    await vi.waitFor(() => {
      const after = fake.sent.slice(beforeRecreate);
      expect(after).toContainEqual(['vf', 'add', DEINTERLACE_BWDIF_FILTER]);
      expect(after).toContainEqual(['set_property', 'audio-pitch-correction', 'no']);
      expect(after).toContainEqual(['af', 'add', LOUDNORM_FILTER]);
    });
  });

  it('observes runtime audio-spdif property changes, removing @elv_loudnorm when active and restoring when inactive (#243)', async () => {
    const spdifToggleScript: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 3, event: 'file-loaded' },
      { afterMs: 4, property: 'duration', value: 1200 },
      { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
      { afterMs: 6, property: 'time-pos', value: 1 },
      { afterMs: 7, event: 'playback-restart' },
      { afterMs: 35, property: 'audio-spdif', value: 'ac3,eac3' },
      { afterMs: 70, property: 'audio-spdif', value: '' },
    ];
    const { engine, fake, events } = await setupEngineTest(cleanups, {
      scripts: { [URL_EP1]: spdifToggleScript },
    });
    engine.setAudioNormalization(true);
    engine.load({ attempt: 1, url: URL_EP1, headers: {}, kind: 'vod' });
    await playing(events, 1);

    await vi.waitFor(() => {
      const afCmds = fake.sent.filter((c) => c[0] === 'af');
      const addIdx1 = afCmds.findIndex((c) => c[1] === 'add' && c[2] === LOUDNORM_FILTER);
      const removeIdx = afCmds.findIndex(
        (c, i) => i > addIdx1 && c[1] === 'remove' && c[2] === '@elv_loudnorm',
      );
      const addIdx2 = afCmds.findIndex(
        (c, i) => i > removeIdx && c[1] === 'add' && c[2] === LOUDNORM_FILTER,
      );
      expect(addIdx1).toBeGreaterThanOrEqual(0);
      expect(removeIdx).toBeGreaterThan(addIdx1);
      expect(addIdx2).toBeGreaterThan(removeIdx);
    });
    expect(fake.sent.some((c) => c[0] === 'observe_property' && c[2] === 'audio-spdif')).toBe(true);
  });

  it('re-applies deinterlaceMode auto after start-file across load(), zap, and recreate() despite --reset-on-next-file (#243)', async () => {
    const { engine, fake, events } = await setupEngineTest(cleanups, {
      scripts: { [URL_EP1]: EP_HOLD, [URL_EP2]: EP_HOLD },
    });
    engine.setDeinterlaceMode('auto');

    // Initial load
    engine.load({ attempt: 1, url: URL_EP1, headers: {}, kind: 'vod' });
    await playing(events, 1);
    await vi.waitFor(() => {
      const startIdx = fake.trace.findIndex((t) => t.startsWith('< start-file'));
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(fake.trace.slice(startIdx + 1)).toContain('> set_property deinterlace auto');
    });

    // Zap to another stream
    const beforeZapTrace = fake.trace.length;
    engine.load({ attempt: 2, url: URL_EP2, headers: {}, kind: 'vod' });
    await playing(events, 2);
    await vi.waitFor(() => {
      const afterZap = fake.trace.slice(beforeZapTrace);
      const startIdx = afterZap.findIndex((t) => t.startsWith('< start-file'));
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(afterZap.slice(startIdx + 1)).toContain('> set_property deinterlace auto');
    });

    // Recreate + subsequent load
    const beforeRecreateTrace = fake.trace.length;
    engine.recreate(3);
    engine.load({ attempt: 3, url: URL_EP1, headers: {}, kind: 'vod' });
    await playing(events, 3);
    await vi.waitFor(() => {
      const afterRecreate = fake.trace.slice(beforeRecreateTrace);
      const startIdx = afterRecreate.findIndex((t) => t.startsWith('< start-file'));
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(afterRecreate.slice(startIdx + 1)).toContain('> set_property deinterlace auto');
    });
  });
});

describe('Wave C5A #205: gapless series auto-advance via mpv append-play', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  it('queues next VOD episode via append-play, suppresses premature ended on EOF, and emits queueAdvanced on start-file', async () => {
    const { engine, fake, events, ui } = await setupEngineTest(cleanups, {
      scripts: { [URL_EP1]: EP1_EOF, [URL_EP2]: EP2_PLAYING },
    });
    const advanced: string[] = [];
    const off = engine.onQueueAdvanced((key) => advanced.push(key));

    engine.load({ attempt: 1, url: URL_EP1, headers: { 'User-Agent': 'ELV' }, kind: 'vod' });
    await playing(events, 1);

    engine.queueNext({
      itemKey: 'xtream:s1:ep2',
      stream: { url: URL_EP2, headers: { 'User-Agent': 'ELV' } },
      preferHevcOverDolbyVision: true,
      filterSdhSubtitles: true,
    });

    await vi.waitFor(() => expect(advanced).toEqual(['xtream:s1:ep2']));
    await vi.waitFor(() =>
      expect(
        events.filter((e) => e.attempt === 1 && e.type === 'state' && e.state === 'playing').length,
      ).toBeGreaterThanOrEqual(2),
    );

    // Terminal 'ended' was suppressed across the gapless transition!
    expect(states(events, 1)).not.toContain('ended');
    // Single connection invariant: never more than 1 open entry at a time
    expect(fake.maxOpenEntries()).toBe(1);
    expect(
      fake.sent.some(
        (c) => c[0] === 'loadfile' && c[1] === URL_EP2 && c[2] === 'append-play' && c[3] === -1,
      ),
    ).toBe(true);
    expect(ui).toContainEqual<PlayerUiEvent>({
      type: 'queueAdvanced',
      itemKey: 'xtream:s1:ep2',
      attempt: 1,
    });

    off();
  });

  it('issues playlist-clear when replacing a prior queued episode, on clearQueue(), on manual load(), and on stop()', async () => {
    const { engine, fake, events } = await setupEngineTest(cleanups, {
      scripts: { [URL_EP1]: EP_HOLD, [URL_EP2]: EP2_PLAYING, [URL_EP3]: EP2_PLAYING },
    });

    engine.load({ attempt: 1, url: URL_EP1, headers: {}, kind: 'vod' });
    await playing(events, 1);

    engine.queueNext({
      itemKey: 'ep2',
      stream: { url: URL_EP2, headers: {} },
    });
    await vi.waitFor(() =>
      expect(fake.sent.some((c) => c[0] === 'loadfile' && c[1] === URL_EP2)).toBe(true),
    );

    // Replacing queued episode clears prior playlist entry first
    const beforeReplace = fake.sent.length;
    engine.queueNext({
      itemKey: 'ep3',
      stream: { url: URL_EP3, headers: {} },
    });
    await vi.waitFor(() =>
      expect(
        fake.sent.slice(beforeReplace).some((c) => c[0] === 'loadfile' && c[1] === URL_EP3),
      ).toBe(true),
    );
    expect(fake.sent.slice(beforeReplace)).toContainEqual(['playlist-clear']);

    // Manual clearQueue() sends playlist-clear
    const beforeClear = fake.sent.length;
    engine.clearQueue();
    await vi.waitFor(() => expect(fake.sent.slice(beforeClear)).toContainEqual(['playlist-clear']));

    // Queue again, then manual zap (load) must clear playlist before replacing
    engine.queueNext({
      itemKey: 'ep2',
      stream: { url: URL_EP2, headers: {} },
    });
    await vi.waitFor(() =>
      expect(
        fake.sent.filter((c) => c[0] === 'loadfile' && c[1] === URL_EP2 && c[2] === 'append-play'),
      ).toHaveLength(2),
    );
    const beforeZap = fake.sent.length;
    engine.load({ attempt: 2, url: URL_EP3, headers: {}, kind: 'vod' });
    await playing(events, 2);
    expect(fake.sent.slice(beforeZap)).toContainEqual(['playlist-clear']);

    // Queue again, then stop() must send playlist-clear
    engine.queueNext({
      itemKey: 'ep2',
      stream: { url: URL_EP2, headers: {} },
    });
    await vi.waitFor(() =>
      expect(
        fake.sent.filter((c) => c[0] === 'loadfile' && c[1] === URL_EP2 && c[2] === 'append-play'),
      ).toHaveLength(3),
    );
    const beforeStop = fake.sent.length;
    engine.stop(3);
    await vi.waitFor(() => expect(fake.sent.slice(beforeStop)).toContainEqual(['stop']));
    expect(fake.sent.slice(beforeStop)).toContainEqual(['playlist-clear']);
  });

  it('rejects append-play when custom HTTP headers differ from active media or when active media is live', async () => {
    const { engine, fake, events } = await setupEngineTest(cleanups, {
      scripts: { [URL_EP1]: EP_HOLD, [URL_EP2]: EP2_PLAYING, [URL_LIVE]: EP_HOLD },
    });

    engine.load({
      attempt: 1,
      url: URL_EP1,
      headers: { 'X-Token': 'alpha', 'User-Agent': 'ELV/1' },
      kind: 'vod',
    });
    await playing(events, 1);

    // Custom header mismatch -> ignored safely (no append-play sent)
    engine.queueNext({
      itemKey: 'ep2-mismatch',
      stream: { url: URL_EP2, headers: { 'X-Token': 'beta', 'User-Agent': 'ELV/1' } },
    });
    await sleep(30);
    expect(fake.sent.some((c) => c[0] === 'loadfile' && c[2] === 'append-play')).toBe(false);

    // Live media -> ignored safely
    engine.load({ attempt: 2, url: URL_LIVE, headers: {}, kind: 'live' });
    await playing(events, 2);
    engine.queueNext({
      itemKey: 'ep2-live',
      stream: { url: URL_EP2, headers: {} },
    });
    await sleep(30);
    expect(fake.sent.some((c) => c[0] === 'loadfile' && c[2] === 'append-play')).toBe(false);
  });

  it('keeps promoted entry bound when start-file beats loadfile append-play IPC reply (#205)', async () => {
    const ep1QuickEof: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 3, event: 'file-loaded' },
      { afterMs: 4, property: 'duration', value: 1200 },
      { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
      { afterMs: 6, property: 'time-pos', value: 1199 },
      { afterMs: 7, event: 'playback-restart' },
      { afterMs: 35, event: 'end-file', reason: 'eof' },
    ];
    const ep2DelayedFinish: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 25, event: 'file-loaded' },
      { afterMs: 28, property: 'duration', value: 1400 },
      { afterMs: 30, property: 'video-params', value: { w: 1920, h: 1080 } },
      { afterMs: 32, property: 'time-pos', value: 1399 },
      { afterMs: 35, event: 'playback-restart' },
      { afterMs: 50, event: 'end-file', reason: 'eof' },
    ];

    const fake = createFakeMpv({
      scripts: { [URL_EP1]: ep1QuickEof, [URL_EP2]: ep2DelayedFinish },
      transport: 'socket',
    });
    let releaseAppendReply: (() => void) | undefined;
    const ui: PlayerUiEvent[] = [];

    const engine = createMpvEngine({
      spawn: async (args, signal) => {
        const proc = await fake.spawn(args, signal);
        const origCommand = proc.client.command.bind(proc.client);
        return {
          ...proc,
          client: {
            ...proc.client,
            command: (cmd) => {
              const replyPromise = origCommand(cmd);
              if (cmd[0] === 'loadfile' && cmd[2] === 'append-play') {
                return new Promise((resolve, reject) => {
                  releaseAppendReply = () => {
                    void replyPromise.then(resolve, reject);
                  };
                });
              }
              return replyPromise;
            },
          },
        };
      },
      presenter: stubPresenter(),
      baseArgs: LAUNCH_OPTIONS,
      loadMode: 'replace',
      now: () => Date.now(),
      timers,
      onUi: (e) => {
        ui.push(e);
        if (e.type === 'queueAdvanced') {
          // Resolve the delayed append-play IPC reply right AFTER start-file promoted the slot!
          releaseAppendReply?.();
        }
      },
    });
    cleanups.push(async () => {
      engine.release();
      await fake.dispose();
    });

    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    engine.load({ attempt: 1, url: URL_EP1, headers: {}, kind: 'vod' });
    await playing(events, 1);

    engine.queueNext({
      itemKey: 'ep2-race',
      stream: { url: URL_EP2, headers: {} },
    });

    // Wait for Ep 2 to promote, play, and finish (proving its entry was NOT unbound!).
    await vi.waitFor(() =>
      expect(ui).toContainEqual<PlayerUiEvent>({
        type: 'queueAdvanced',
        itemKey: 'ep2-race',
        attempt: 1,
      }),
    );
    await vi.waitFor(() =>
      expect(
        events.filter((e) => e.attempt === 1 && e.type === 'state' && e.state === 'playing').length,
      ).toBeGreaterThanOrEqual(2),
    );
    await vi.waitFor(() => expect(states(events, 1)).toContain('ended'));
  });
});
