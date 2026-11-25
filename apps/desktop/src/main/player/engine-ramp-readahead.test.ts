import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advanceUntil,
  live,
  playing,
  type SetupOptions,
  setupEngineTest,
  sleep,
  states,
  URL_A,
  URL_B,
  URL_VOD,
  until,
  VOD,
} from './engine-test-helpers.ts';
import { FAKE_PLAYING, type FakeMpvScript } from './mpv/fake-mpv.ts';
import { createReadaheadTierStore } from './mpv/readahead.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0)) await c();
});

const setup = (o: SetupOptions = {}) => setupEngineTest(cleanups, o);

describe('MpvEngine hwdec profile switching (#210, #435)', () => {
  it('applies hwdec profiles on non-darwin and darwin (including uyvy422 for darwin-compat)', async () => {
    const win = await setup({ platform: 'win32' });
    win.engine.load(live(1, URL_A));
    await playing(win.events, 1);

    win.engine.setHwdec('auto-copy');
    win.engine.setHwdec('no');
    win.engine.setHwdec('darwin-compat');
    await vi.waitFor(() =>
      expect(win.fake.sent.filter((c) => c[0] === 'set_property' && c[1] === 'hwdec')).toEqual([
        ['set_property', 'hwdec', 'auto-copy'],
        ['set_property', 'hwdec', 'no'],
        ['set_property', 'hwdec', 'auto-safe'],
      ]),
    );
    expect(
      win.fake.sent.some((c) => c[0] === 'set_property' && c[1] === 'hwdec-image-format'),
    ).toBe(false);

    const mac = await setup({ platform: 'darwin' });
    mac.engine.load(live(1, URL_A));
    await playing(mac.events, 1);

    mac.engine.setHwdec('darwin-compat');
    await vi.waitFor(() =>
      expect(mac.fake.sent).toContainEqual(['set_property', 'hwdec-image-format', 'uyvy422']),
    );
    expect(mac.fake.sent).toContainEqual(['set_property', 'hwdec', 'auto-safe']);

    mac.engine.setHwdec('auto-copy');
    await vi.waitFor(() =>
      expect(mac.fake.sent).toContainEqual(['set_property', 'hwdec-image-format', 'no']),
    );
    expect(mac.fake.sent).toContainEqual(['set_property', 'hwdec', 'auto-copy']);

    const countBeforeRelease = mac.fake.sent.length;
    mac.engine.release();
    mac.engine.setHwdec('no');
    await sleep(20);
    expect(mac.fake.sent.slice(countBeforeRelease).every((c) => c[0] !== 'set_property')).toBe(
      true,
    );
  });

  it('clears hwdec-image-format on macOS when launched with darwin-compat and later switched to auto-safe', async () => {
    const mac = await setup({
      platform: 'darwin',
      baseArgs: ['--idle=yes', '--hwdec=auto-safe', '--hwdec-image-format=uyvy422'],
    });
    mac.engine.load(live(1, URL_A));
    await playing(mac.events, 1);

    mac.engine.setHwdec('auto-safe');
    await vi.waitFor(() =>
      expect(mac.fake.sent).toContainEqual(['set_property', 'hwdec-image-format', 'no']),
    );
    expect(mac.fake.sent).toContainEqual(['set_property', 'hwdec', 'auto-safe']);
  });
});

describe('MpvEngine smooth 175 ms play/pause audio ramp (#254)', () => {
  const volCmds = (sent: readonly (readonly unknown[])[]) =>
    sent.filter((c) => c[0] === 'set_property' && c[1] === 'volume').map((c) => c[2] as number);

  it('ramps volume down before pause=yes, restores savedVolume, then ramps up on play=no', async () => {
    const { engine, fake, events } = await setup();
    engine.load(live(1, URL_A));
    await playing(events, 1);

    engine.setVolume(80);
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['set_property', 'volume', 80]));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const markPause = fake.sent.length;
    engine.pause(2);

    await vi.advanceTimersByTimeAsync(100);
    await new Promise((r) => setImmediate(r));
    expect(fake.sent.slice(markPause)).not.toContainEqual(['set', 'pause', 'yes']);

    await advanceUntil(() => states(events, 2).includes('paused'), 25);
    await until(() => volCmds(fake.sent.slice(markPause)).at(-1) === 80);
    const pauseSlice = fake.sent.slice(markPause);
    const pauseIdx = pauseSlice.findIndex(
      (c) => c[0] === 'set' && c[1] === 'pause' && c[2] === 'yes',
    );
    expect(pauseIdx).toBeGreaterThan(0);
    expect(volCmds(pauseSlice.slice(0, pauseIdx)).at(-1)).toBe(0);
    expect(volCmds(pauseSlice.slice(pauseIdx + 1))).toContain(80);

    const markPlay = fake.sent.length;
    engine.play(3);
    await advanceUntil(() => states(events, 3).includes('playing'), 25);
    await advanceUntil(() => volCmds(fake.sent.slice(markPlay)).at(-1) === 80, 25);
    const playSlice = fake.sent.slice(markPlay);
    const playIdx = playSlice.findIndex((c) => c[0] === 'set' && c[1] === 'pause' && c[2] === 'no');
    expect(playIdx).toBeGreaterThan(0);
    expect(volCmds(playSlice.slice(0, playIdx))).toEqual([0]);
    expect(volCmds(playSlice.slice(playIdx + 1)).at(-1)).toBe(80);
  });

  it('rapid pause -> play interrupts down-ramp smoothly without snapping to 0 or sending pause=yes', async () => {
    const { engine, fake, events } = await setup();
    engine.load(live(1, URL_A));
    await playing(events, 1);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const mark = fake.sent.length;
    engine.pause(2);
    await vi.advanceTimersByTimeAsync(75);
    await until(() => volCmds(fake.sent.slice(mark)).length >= 2);

    engine.play(3);
    await advanceUntil(() => volCmds(fake.sent.slice(mark)).at(-1) === 100, 25);

    const slice = fake.sent.slice(mark);
    expect(slice).not.toContainEqual(['set', 'pause', 'yes']);
    expect(volCmds(slice)).not.toContain(0);
    expect(volCmds(slice).at(-1)).toBe(100);
  });

  it('cancels pause ramp and restores volume on stop -> load, seek, and toggleMute', async () => {
    const { engine, fake, events, presenter } = await setup({ scripts: { [URL_VOD]: VOD } });
    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod' });
    await playing(events, 1);

    engine.setVolume(70);
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['set_property', 'volume', 70]));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    const markSeek = fake.sent.length;
    engine.pause(2);
    await vi.advanceTimersByTimeAsync(50);
    await until(() => volCmds(fake.sent.slice(markSeek)).length >= 1);
    engine.seek(3, 10_000);
    await advanceUntil(() => volCmds(fake.sent.slice(markSeek)).at(-1) === 70, 25);
    await vi.advanceTimersByTimeAsync(250);
    await new Promise((r) => setImmediate(r));
    expect(fake.sent.slice(markSeek)).not.toContainEqual(['set', 'pause', 'yes']);
    expect(volCmds(fake.sent.slice(markSeek)).at(-1)).toBe(70);

    const markMute = fake.sent.length;
    engine.pause(4);
    await vi.advanceTimersByTimeAsync(50);
    await until(() => volCmds(fake.sent.slice(markMute)).length >= 1);
    engine.toggleMute();
    await advanceUntil(() => volCmds(fake.sent.slice(markMute)).at(-1) === 70, 25);
    await vi.advanceTimersByTimeAsync(250);
    await new Promise((r) => setImmediate(r));
    expect(fake.sent.slice(markMute)).not.toContainEqual(['set', 'pause', 'yes']);
    expect(volCmds(fake.sent.slice(markMute)).at(-1)).toBe(70);

    engine.toggleMute();
    await until(() => fake.sent.filter((c) => c[0] === 'cycle' && c[1] === 'mute').length === 2);
    await presenter.attached[0]?.command(['get_property', 'mute']);

    const markStop = fake.sent.length;
    engine.pause(5);
    await vi.advanceTimersByTimeAsync(50);
    await until(() => volCmds(fake.sent.slice(markStop)).length >= 1);
    engine.stop(6);
    engine.load(live(7, URL_B));
    await advanceUntil(() => states(events, 7).includes('playing'), 25);
    await until(() => volCmds(fake.sent.slice(markStop)).at(-1) === 70);
    await vi.advanceTimersByTimeAsync(250);
    await new Promise((r) => setImmediate(r));
    expect(fake.sent.slice(markStop)).not.toContainEqual(['set', 'pause', 'yes']);
    expect(volCmds(fake.sent.slice(markStop)).at(-1)).toBe(70);
  });

  it('release() mid-ramp restores savedVolume before quit and emits zero stale commands', async () => {
    const { engine, fake, events } = await setup();
    engine.load(live(1, URL_A));
    await playing(events, 1);

    engine.setVolume(65);
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['set_property', 'volume', 65]));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const mark = fake.sent.length;
    engine.pause(2);
    await vi.advanceTimersByTimeAsync(50);
    await new Promise((r) => setImmediate(r));

    engine.release();
    await until(() => fake.sent.at(-1)?.[0] === 'quit');
    const sentAtRelease = fake.sent.length;
    await vi.advanceTimersByTimeAsync(300);
    await new Promise((r) => setImmediate(r));

    expect(fake.sent.length).toBe(sentAtRelease);
    const slice = fake.sent.slice(mark);
    expect(slice).not.toContainEqual(['set', 'pause', 'yes']);
    expect(volCmds(slice).at(-1)).toBe(65);
    expect(fake.sent.at(-1)).toEqual(['quit']);
  });
});

describe('MpvEngine adaptive readahead tiers (#196)', () => {
  const readaheadCmds = (sent: readonly (readonly unknown[])[]) =>
    sent
      .filter((c) => c[0] === 'set_property' && c[1] === 'demuxer-readahead-secs')
      .map((c) => c[2] as number);

  it('steps up demuxer-readahead-secs on post-firstFrame paused-for-cache and remembers tier per stream', async () => {
    const store = createReadaheadTierStore();
    const stallingStream: FakeMpvScript = [
      ...FAKE_PLAYING,
      { afterMs: 30, property: 'paused-for-cache', value: true },
      { afterMs: 40, property: 'paused-for-cache', value: false },
    ];
    const { engine, fake, events } = await setup({
      scripts: { [URL_A]: stallingStream, [URL_B]: FAKE_PLAYING },
      readaheadStore: store,
    });

    engine.load(live(1, URL_A));
    await playing(events, 1);
    await vi.waitFor(() => expect(readaheadCmds(fake.sent)).toEqual([4, 8]));

    engine.load(live(2, URL_B));
    await playing(events, 2);
    await vi.waitFor(() => expect(readaheadCmds(fake.sent)).toEqual([4, 8, 4]));

    engine.load(live(3, URL_A));
    await playing(events, 3);
    await vi.waitFor(() => expect(readaheadCmds(fake.sent).slice(0, 4)).toEqual([4, 8, 4, 8]));
  });
});
