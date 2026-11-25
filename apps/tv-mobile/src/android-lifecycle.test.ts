import { describe, expect, it, vi } from 'vitest';
import { createComposedAppLifecycle } from './android-lifecycle';

function makeAppState(initial = 'active') {
  const listeners = new Set<(next: string) => void>();
  const remove = vi.fn();
  const state = {
    currentState: initial,
    addEventListener: vi.fn((_event: 'change', listener: (next: string) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          remove();
          listeners.delete(listener);
        },
      };
    }),
  };
  const emit = (next: string) => {
    state.currentState = next;
    for (const l of [...listeners]) l(next);
  };
  return { state, emit, remove, listeners };
}

function makeBoolSource() {
  const listeners = new Set<(value: boolean) => void>();
  const unsub = vi.fn();
  const subscribe = vi.fn((listener: (value: boolean) => void) => {
    listeners.add(listener);
    return () => {
      unsub();
      listeners.delete(listener);
    };
  });
  const emit = (value: boolean) => {
    for (const l of [...listeners]) l(value);
  };
  return { subscribe, emit, unsub, listeners };
}

describe('createComposedAppLifecycle (#143, #266)', () => {
  it('forwards standard AppState transitions and HDMI-CEC standby signals (#143)', () => {
    const appState = makeAppState('active');
    const standby = makeBoolSource();
    const lifecycle = createComposedAppLifecycle({
      appState: appState.state,
      subscribeStandby: standby.subscribe,
    });

    const events: Array<'active' | 'background'> = [];
    const off = lifecycle.subscribe((s) => events.push(s));

    // HDMI-CEC standby true -> background; standby false while active -> active
    standby.emit(true);
    expect(events).toEqual(['background']);

    // AppState active while still in standby must stay backgrounded
    appState.emit('active');
    expect(events).toEqual(['background']);

    standby.emit(false);
    expect(events).toEqual(['background', 'active']);

    // Standby true while already backgrounded is deduplicated (strictly transition-only)
    appState.emit('background');
    standby.emit(true);
    standby.emit(false);
    expect(events).toEqual(['background', 'active', 'background']);

    off();
    expect(appState.remove).toHaveBeenCalledTimes(1);
    expect(standby.unsub).toHaveBeenCalledTimes(1);
  });

  it('suppresses background teardown while in PiP and emits background immediately if PiP exits while not active (#266)', () => {
    const appState = makeAppState('active');
    const pip = makeBoolSource();
    const lifecycle = createComposedAppLifecycle({
      appState: appState.state,
      subscribePip: pip.subscribe,
    });

    const events: Array<'active' | 'background'> = [];
    const off = lifecycle.subscribe((s) => events.push(s));

    // Enter PiP -> AppState transitions to inactive/background -> suppressed!
    pip.emit(true);
    appState.emit('inactive');
    appState.emit('background');
    expect(events).toEqual([]);

    // User closes PiP window while app is still in background -> emits background immediately!
    pip.emit(false);
    expect(events).toEqual(['background']);

    // Returning to foreground emits active
    appState.emit('active');
    expect(events).toEqual(['background', 'active']);

    // Expanding PiP back to fullscreen while app returns active does NOT emit duplicate active or background
    pip.emit(true);
    appState.emit('background');
    appState.emit('active');
    pip.emit(false);
    expect(events).toEqual(['background', 'active']);

    off();
    expect(appState.remove).toHaveBeenCalledTimes(1);
    expect(pip.unsub).toHaveBeenCalledTimes(1);
  });

  it('suppresses background stop for Apple subscribePip without standby subscription (#34)', () => {
    const appState = makeAppState('active');
    const applePip = makeBoolSource();
    const lifecycle = createComposedAppLifecycle({
      appState: appState.state,
      subscribePip: applePip.subscribe,
    });

    const events: Array<'active' | 'background'> = [];
    const off = lifecycle.subscribe((s) => events.push(s));

    applePip.emit(true);
    appState.emit('background');
    expect(events).toEqual([]);

    applePip.emit(false);
    expect(events).toEqual(['background']);

    off();
    expect(applePip.unsub).toHaveBeenCalledTimes(1);
  });
});
