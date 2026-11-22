import { describe, expect, it } from 'vitest';
import { type AppStateLike, waitForCatalogForeground } from './ios-prewarm-gate';

function createFakeAppState(initial: string) {
  let currentState = initial;
  const listeners = new Set<(state: string) => void>();
  let removedCount = 0;

  const appState: AppStateLike = {
    get currentState() {
      return currentState;
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
      return {
        remove() {
          if (listeners.delete(listener)) removedCount += 1;
        },
      };
    },
  };

  return {
    appState,
    emit(next: string) {
      currentState = next;
      for (const listener of [...listeners]) listener(next);
    },
    get listenerCount() {
      return listeners.size;
    },
    get removedCount() {
      return removedCount;
    },
  };
}

describe('waitForCatalogForeground (#138)', () => {
  it('resolves immediately on Android regardless of AppState', async () => {
    const fake = createFakeAppState('background');
    await waitForCatalogForeground('android', fake.appState);
    expect(fake.listenerCount).toBe(0);
    expect(fake.removedCount).toBe(0);
  });

  it('resolves immediately on iOS when AppState is already active', async () => {
    const fake = createFakeAppState('active');
    await waitForCatalogForeground('ios', fake.appState);
    expect(fake.listenerCount).toBe(0);
    expect(fake.removedCount).toBe(0);
  });

  it('defers on iOS while background or inactive and resolves + unsubscribes once active', async () => {
    const fake = createFakeAppState('background');
    let resolved = false;
    const pending = waitForCatalogForeground('ios', fake.appState).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(fake.listenerCount).toBe(1);

    fake.emit('inactive');
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(fake.listenerCount).toBe(1);

    fake.emit('active');
    await pending;
    expect(resolved).toBe(true);
    expect(fake.listenerCount).toBe(0);
    expect(fake.removedCount).toBe(1);
  });
});
