/** Minimal React Native `AppState` surface needed to defer SQLite opens during iOS prewarm. */
export interface AppStateLike {
  readonly currentState: string | null | undefined;
  addEventListener(type: 'change', listener: (nextState: string) => void): { remove(): void };
}

function isDeferredIosState(state: string | null | undefined): boolean {
  return state === 'background' || state === 'inactive';
}

/**
 * On iOS, when `AppState.currentState` is `'background'` or `'inactive'`, waits until `'active'`
 * before opening SQLite so iOS background prewarming never acquires file locks across suspension
 * (`0xdead10cc`, `#138`). On non-iOS platforms or when already active, resolves immediately.
 */
export function waitForCatalogForeground(os: string, appState: AppStateLike): Promise<void> {
  if (os !== 'ios' || !isDeferredIosState(appState.currentState)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    let sub: { remove(): void } | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      sub?.remove();
      resolve();
    };
    sub = appState.addEventListener('change', (nextState) => {
      if (nextState === 'active') finish();
    });
    if (!isDeferredIosState(appState.currentState)) finish();
  });
}
