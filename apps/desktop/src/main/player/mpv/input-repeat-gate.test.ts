import { describe, expect, it } from 'vitest';
import { AUTOREPEAT_MS, createInputRepeatGate, LONG_HOLD_MS } from './input-repeat-gate.ts';

describe('createInputRepeatGate', () => {
  it('exports the expected timing constants', () => {
    expect(LONG_HOLD_MS).toBe(350);
    expect(AUTOREPEAT_MS).toBe(160);
  });

  it('passes isolated repeatable presses more than 600 ms apart immediately', () => {
    let clock = 1000;
    const gate = createInputRepeatGate({ now: () => clock });

    expect(gate.allow('channel-up')).toBe(true);
    clock += 601;
    expect(gate.allow('channel-up')).toBe(true);
    clock += 601;
    expect(gate.allow('channel-up')).toBe(true);
    clock += 1200;
    expect(gate.allow('channel-up')).toBe(true);
  });

  it('throttles a rapid 30-event held-key storm over 1000 ms to initial press plus 4 repeats', () => {
    let clock = 0;
    const gate = createInputRepeatGate({ now: () => clock });
    const allowedAt: number[] = [];

    for (let i = 0; i < 30; i += 1) {
      clock = i * 33;
      if (gate.allow('channel-up')) allowedAt.push(clock);
    }

    expect(allowedAt).toEqual([0, 363, 528, 693, 858]);
  });

  it('enforces exact longHoldMs (350 ms) and repeatIntervalMs (160 ms) boundaries', () => {
    let clock = 100;
    const gate = createInputRepeatGate({ now: () => clock });

    expect(gate.allow('seek-forward')).toBe(true);

    clock = 449; // +349 ms < 350 ms
    expect(gate.allow('seek-forward')).toBe(false);

    clock = 450; // +350 ms === longHoldMs
    expect(gate.allow('seek-forward')).toBe(true);

    clock = 609; // +159 ms < 160 ms
    expect(gate.allow('seek-forward')).toBe(false);

    clock = 610; // +160 ms === repeatIntervalMs
    expect(gate.allow('seek-forward')).toBe(true);
  });

  it('passes immediately when switching between repeatable keys', () => {
    let clock = 0;
    const gate = createInputRepeatGate({ now: () => clock });

    expect(gate.allow('channel-up')).toBe(true);
    clock = 30;
    expect(gate.allow('channel-up')).toBe(false);
    clock = 60;
    expect(gate.allow('channel-down')).toBe(true);
    clock = 90;
    expect(gate.allow('channel-down')).toBe(false);
    clock = 120;
    expect(gate.allow('channel-up')).toBe(true);
  });

  it('gates all default repeatable keys', () => {
    const keys = [
      'channel-up',
      'channel-down',
      'seek-back',
      'seek-forward',
      'seek-coarse-back',
      'seek-coarse-forward',
    ];
    for (const key of keys) {
      let clock = 0;
      const gate = createInputRepeatGate({ now: () => clock });
      expect(gate.allow(key)).toBe(true);
      clock = 50;
      expect(gate.allow(key)).toBe(false);
    }
  });

  it('always passes non-repeatable keys and resets active hold state', () => {
    let clock = 0;
    const gate = createInputRepeatGate({ now: () => clock });

    for (const key of ['back', 'close', 'fullscreen', 'play-pause', 'seek-home', 'seek-end']) {
      clock += 10;
      expect(gate.allow(key)).toBe(true);
      clock += 10;
      expect(gate.allow(key)).toBe(true);
    }

    clock += 10;
    expect(gate.allow('channel-up')).toBe(true);
    clock += 20;
    expect(gate.allow('channel-up')).toBe(false);
    clock += 20;
    expect(gate.allow('back')).toBe(true);
    clock += 20;
    expect(gate.allow('channel-up')).toBe(true);
  });

  it('resets hold state on reset() and on idle gap > 600 ms', () => {
    let clock = 0;
    const gate = createInputRepeatGate({ now: () => clock });

    expect(gate.allow('channel-up')).toBe(true);
    clock = 50;
    expect(gate.allow('channel-up')).toBe(false);

    gate.reset();
    clock = 60;
    expect(gate.allow('channel-up')).toBe(true);

    // Exactly 600 ms is still within idleResetMs (continuous hold); longHoldMs has elapsed so it repeats.
    clock = 660;
    expect(gate.allow('channel-up')).toBe(true);
    // 50 ms later is still within repeatIntervalMs -> dropped.
    clock = 710;
    expect(gate.allow('channel-up')).toBe(false);
    // > 600 ms after lastSeen (710) starts a fresh hold -> passes immediately, then drops at +50 ms.
    clock = 1311;
    expect(gate.allow('channel-up')).toBe(true);
    clock = 1361;
    expect(gate.allow('channel-up')).toBe(false);
  });

  it('supports custom intervals and repeatable key sets, and handles clock rollback safely', () => {
    let clock = 500;
    const gate = createInputRepeatGate({
      now: () => clock,
      longHoldMs: 200,
      repeatIntervalMs: 100,
      repeatableKeys: ['custom-key'],
    });

    expect(gate.allow('channel-up')).toBe(true);
    clock = 510;
    expect(gate.allow('channel-up')).toBe(true);

    expect(gate.allow('custom-key')).toBe(true);
    clock = 650;
    expect(gate.allow('custom-key')).toBe(false);
    clock = 710;
    expect(gate.allow('custom-key')).toBe(true);
    clock = 750;
    expect(gate.allow('custom-key')).toBe(false);
    clock = 810;
    expect(gate.allow('custom-key')).toBe(true);

    // Clock moves backwards -> treated as fresh hold instead of locking out.
    clock = 100;
    expect(gate.allow('custom-key')).toBe(true);
  });
});
