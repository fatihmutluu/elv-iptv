import { afterEach, describe, expect, it } from 'vitest';
import { type SetupOptions, setupEngineTest } from './engine-test-helpers.ts';

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
});
