import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * A key or focus event from the Android main window. `ageMs` is the time from the key event to its receipt in
 * JavaScript, so a wait for a busy JS thread counts.
 */
export type RemoteKeyEvent =
  | { action: 'down' | 'up'; keyCode: number; canceled: boolean; ageMs: number }
  | { action: 'blur' };

/** Subscribes to window key events; `remove()` ends the subscription. */
export interface RemoteKeySource {
  addListener(listener: (event: RemoteKeyEvent) => void): { remove(): void };
}

type NativeKeyEvent =
  | { action: 'down' | 'up'; keyCode: number; canceled: boolean; eventTime: number }
  | { action: 'blur' };

interface NativeRemoteKeys {
  addListener(eventName: 'onKey', listener: (event: NativeKeyEvent) => void): { remove(): void };
  uptimeMs(): number;
}

const native = requireOptionalNativeModule<NativeRemoteKeys>('ElvRemoteKeys');

function received(event: NativeKeyEvent, module: NativeRemoteKeys): RemoteKeyEvent {
  if (event.action === 'blur') return event;
  const { action, keyCode, canceled, eventTime } = event;
  return { action, keyCode, canceled, ageMs: Math.max(0, module.uptimeMs() - eventTime) };
}

/** The Android window key source, or null where the native module is absent (iOS, web). */
export const remoteKeys: RemoteKeySource | null = native
  ? {
      addListener: (listener) =>
        native.addListener('onKey', (event) => listener(received(event, native))),
    }
  : null;
