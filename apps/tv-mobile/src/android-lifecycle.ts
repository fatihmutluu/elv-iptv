import type { AppLifecyclePort } from '@elv/features';

/** Minimal `AppState` surface required by {@link createComposedAppLifecycle}. */
interface AppStateSource {
  readonly currentState?: string | null;
  addEventListener(type: 'change', listener: (nextState: string) => void): { remove(): void };
}

/** Collaborators for {@link createComposedAppLifecycle}. */
export interface ComposedAppLifecycleDeps {
  readonly appState: AppStateSource;
  /** Android TV debounced HDMI-CEC / display standby subscription (`#143`). */
  readonly subscribeStandby?: (listener: (standby: boolean) => void) => () => void;
  /** Android mobile Picture-in-Picture mode subscription (`#266`). */
  readonly subscribePip?: (listener: (inPip: boolean) => void) => () => void;
}

/**
 * Composes React Native `AppState`, Android TV HDMI-CEC standby signals (`#143`), and Android
 * Picture-in-Picture mode (`#266`) into a single {@link AppLifecyclePort}:
 * - Standby `true` emits `'background'`; standby `false` emits `'active'` only when `AppState === 'active'`.
 * - While `inPip === true`, `'background'` / `'inactive'` `AppState` transitions are suppressed so PiP keeps playing.
 * - Exiting PiP (`inPip === false`) while `AppState !== 'active'` emits `'background'` immediately.
 */
export function createComposedAppLifecycle(deps: ComposedAppLifecycleDeps): AppLifecyclePort {
  return {
    subscribe(listener) {
      let currentAppState = deps.appState.currentState ?? 'active';
      let inStandby = false;
      let inPip = false;
      let lastEmitted: 'active' | 'background' | undefined;

      const emit = (next: 'active' | 'background'): void => {
        if (lastEmitted === next) return;
        lastEmitted = next;
        listener(next);
      };

      const appSub = deps.appState.addEventListener('change', (nextState) => {
        currentAppState = nextState;
        if (nextState === 'active') {
          if (!inStandby) emit('active');
        } else if (nextState === 'background') {
          if (!inPip) emit('background');
        }
      });

      const offStandby = deps.subscribeStandby?.((standby) => {
        inStandby = standby;
        if (standby) {
          emit('background');
        } else if (currentAppState === 'active') {
          emit('active');
        }
      });

      const offPip = deps.subscribePip?.((nextPip) => {
        const wasInPip = inPip;
        inPip = nextPip;
        if (wasInPip && !nextPip && currentAppState !== 'active') {
          emit('background');
        }
      });

      return () => {
        appSub.remove();
        offStandby?.();
        offPip?.();
      };
    },
  };
}
