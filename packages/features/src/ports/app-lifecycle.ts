/** Foreground/background state reported by the host platform (`AppState` on mobile and TV). */
export type AppLifecycleState = 'active' | 'background';

/** Port notifying `PlayerScreen` when the app backgrounds (releasing the stream) or returns active. */
export interface AppLifecyclePort {
  subscribe(listener: (state: AppLifecycleState) => void): () => void;
}

/** Default lifecycle port used when the host has no mobile/TV background standby transitions. */
export const noopAppLifecycle: AppLifecyclePort = {
  subscribe: () => () => undefined,
};
