import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type SetupOptions, setupEngineTest } from './engine-test-helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const inputConfPath = resolve(here, '../../../resources/mpv-input.conf');

const cleanups: Array<() => Promise<void>> = [];
const setup = (o: SetupOptions = {}) => setupEngineTest(cleanups, o);

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('MpvEngine input repeat throttling', () => {
  it('throttles a rapid 20-event channel-up burst over 500 ms to initial press plus 1 repeat', async () => {
    let clock = 1000;
    const { fake, presenter, ui } = await setup({ now: () => clock });
    const client = presenter.attached[0];
    expect(client).toBeDefined();

    for (let i = 0; i < 20; i += 1) {
      clock = 1000 + i * 25; // 20 events spanning 0..475 ms (within 500 ms)
      fake.clientMessage('elv-key', 'channel-up');
      await client?.command(['get_property', 'pause']);
    }

    expect(ui).toEqual([
      { type: 'key', key: 'channel-up' },
      { type: 'key', key: 'channel-up' },
    ]);
  });

  it('emits every isolated channel-up press spaced more than 600 ms apart', async () => {
    let clock = 1000;
    const { fake, presenter, ui } = await setup({ now: () => clock });
    const client = presenter.attached[0];

    for (let i = 0; i < 4; i += 1) {
      clock = 1000 + i * 650;
      fake.clientMessage('elv-key', 'channel-up');
      await client?.command(['get_property', 'pause']);
    }

    expect(ui).toEqual([
      { type: 'key', key: 'channel-up' },
      { type: 'key', key: 'channel-up' },
      { type: 'key', key: 'channel-up' },
      { type: 'key', key: 'channel-up' },
    ]);
  });

  it('never throttles back or close keys even in rapid bursts', async () => {
    let clock = 1000;
    const { fake, presenter, ui } = await setup({ now: () => clock });
    const client = presenter.attached[0];

    for (const key of ['back', 'back', 'close', 'close'] as const) {
      clock += 10;
      fake.clientMessage('elv-key', key);
      await client?.command(['get_property', 'pause']);
    }

    expect(ui).toEqual([
      { type: 'key', key: 'back' },
      { type: 'key', key: 'back' },
      { type: 'key', key: 'close' },
      { type: 'key', key: 'close' },
    ]);
  });

  it('resets hold state on stop so the next repeatable press passes immediately', async () => {
    let clock = 1000;
    const { engine, fake, presenter, ui } = await setup({ now: () => clock });
    const client = presenter.attached[0];

    fake.clientMessage('elv-key', 'channel-up');
    await client?.command(['get_property', 'pause']);

    clock += 50;
    fake.clientMessage('elv-key', 'channel-up');
    await client?.command(['get_property', 'pause']);
    expect(ui).toHaveLength(1);

    engine.stop(1);

    clock += 50;
    fake.clientMessage('elv-key', 'channel-up');
    await client?.command(['get_property', 'pause']);
    expect(ui).toEqual([
      { type: 'key', key: 'channel-up' },
      { type: 'key', key: 'channel-up' },
    ]);
  });

  it('forwards expanded fallback UI keys and throttles repeatable seek keys (#420)', async () => {
    let clock = 1000;
    const { fake, presenter, ui } = await setup({ now: () => clock });
    const client = presenter.attached[0];

    for (const key of ['play-pause', 'mute', 'tracks', 'prev-channel'] as const) {
      clock += 10;
      fake.clientMessage('elv-key', key);
      fake.clientMessage('elv-key', key);
      await client?.command(['get_property', 'pause']);
    }
    expect(ui).toEqual([
      { type: 'key', key: 'play-pause' },
      { type: 'key', key: 'play-pause' },
      { type: 'key', key: 'mute' },
      { type: 'key', key: 'mute' },
      { type: 'key', key: 'tracks' },
      { type: 'key', key: 'tracks' },
      { type: 'key', key: 'prev-channel' },
      { type: 'key', key: 'prev-channel' },
    ]);

    ui.length = 0;
    for (const key of [
      'seek-back',
      'seek-forward',
      'seek-coarse-back',
      'seek-coarse-forward',
    ] as const) {
      clock += 1000;
      fake.clientMessage('elv-key', key);
      await client?.command(['get_property', 'pause']);
      clock += 50; // within LONG_HOLD_MS: dropped
      fake.clientMessage('elv-key', key);
      await client?.command(['get_property', 'pause']);
    }
    expect(ui).toEqual([
      { type: 'key', key: 'seek-back' },
      { type: 'key', key: 'seek-forward' },
      { type: 'key', key: 'seek-coarse-back' },
      { type: 'key', key: 'seek-coarse-forward' },
    ]);
  });

  it('mpv-input.conf maps all required native fallback keys (#420)', () => {
    const lines = readFileSync(inputConfPath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines).toEqual(
      expect.arrayContaining([
        'PGUP script-message elv-key channel-up',
        'PGDWN script-message elv-key channel-down',
        'ESC script-message elv-key back',
        'f script-message elv-key fullscreen',
        'MBTN_LEFT_DBL script-message elv-key fullscreen',
        'q script-message elv-key close',
        'Q script-message elv-key close',
        'SPACE script-message elv-key play-pause',
        'k script-message elv-key play-pause',
        'LEFT script-message elv-key seek-back',
        'j script-message elv-key seek-back',
        'RIGHT script-message elv-key seek-forward',
        'l script-message elv-key seek-forward',
        'Shift+LEFT script-message elv-key seek-coarse-back',
        'Shift+RIGHT script-message elv-key seek-coarse-forward',
        'm script-message elv-key mute',
        'c script-message elv-key tracks',
        'p script-message elv-key prev-channel',
      ]),
    );
  });
});
