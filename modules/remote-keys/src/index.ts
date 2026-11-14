import { requireOptionalNativeModule } from 'expo-modules-core';

/** A key or focus event from the Android main window. `ageMs` is the time between the key event and its delivery. */
export type RemoteKeyEvent =
  | { action: 'down' | 'up'; keyCode: number; canceled: boolean; ageMs: number }
  | { action: 'blur' };

/** Subscribes to window key events; `remove()` ends the subscription. */
export interface RemoteKeySource {
  addListener(listener: (event: RemoteKeyEvent) => void): { remove(): void };
}

interface NativeRemoteKeys {
  addListener(eventName: 'onKey', listener: (event: RemoteKeyEvent) => void): { remove(): void };
}

const native = requireOptionalNativeModule<NativeRemoteKeys>('ElvRemoteKeys');

/** The Android window key source, or null where the native module is absent (iOS, web). */
export const remoteKeys: RemoteKeySource | null = native
  ? { addListener: (listener) => native.addListener('onKey', listener) }
  : null;
