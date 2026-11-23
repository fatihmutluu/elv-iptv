import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * A raw remote key or focus event from the native window (Android `Window.Callback` or tvOS `UIPress`).
 * `ageMs` is the time from the key event to its receipt in JavaScript, so a wait for a busy JS thread counts.
 */
export type RemoteKeyEvent =
  | { action: 'down' | 'up'; keyCode: number; canceled: boolean; ageMs: number }
  | { action: 'blur' };

/** Subscribes to window key events; `remove()` ends the subscription. */
export interface RemoteKeySource {
  addListener(listener: (event: RemoteKeyEvent) => void): { remove(): void };
}

/** Axis-locked Siri Remote touch-surface pan event emitted on tvOS (`#225`). */
export interface RemotePanGestureEvent {
  readonly axis: 'horizontal' | 'vertical';
  readonly phase: 'began' | 'changed' | 'ended' | 'cancelled';
  readonly translation: number;
  readonly velocity: number;
}

/** Subscribes to and gates tvOS Siri Remote directional pan gestures (`#225`). */
export interface RemotePanGestureSource {
  setEnabled(enabled: boolean): void;
  addListener(listener: (event: RemotePanGestureEvent) => void): { remove(): void };
}

type NativeKeyEvent =
  | { action: 'down' | 'up'; keyCode: number; canceled: boolean; eventTime: number }
  | { action: 'blur' };

interface NativeRemoteKeys {
  addListener: {
    (eventName: 'onKey', listener: (event: NativeKeyEvent) => void): { remove(): void };
    (eventName: 'onPanGesture', listener: (event: unknown) => void): { remove(): void };
  };
  uptimeMs(): number;
  setPanGestureEnabled?(enabled: boolean): void;
}

const native = requireOptionalNativeModule<NativeRemoteKeys>('ElvRemoteKeys');

function received(event: NativeKeyEvent, module: NativeRemoteKeys): RemoteKeyEvent {
  if (event.action === 'blur') return event;
  const { action, keyCode, canceled, eventTime } = event;
  return { action, keyCode, canceled, ageMs: Math.max(0, module.uptimeMs() - eventTime) };
}

function parsePanGestureEvent(raw: unknown): RemotePanGestureEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const { axis, phase, translation, velocity } = candidate;
  if (axis !== 'horizontal' && axis !== 'vertical') return null;
  if (phase !== 'began' && phase !== 'changed' && phase !== 'ended' && phase !== 'cancelled') {
    return null;
  }
  if (typeof translation !== 'number' || !Number.isFinite(translation)) return null;
  if (typeof velocity !== 'number' || !Number.isFinite(velocity)) return null;
  return { axis, phase, translation, velocity };
}

/** The native window key source (Android & tvOS), or null where the native module is absent (web). */
export const remoteKeys: RemoteKeySource | null = native
  ? {
      addListener: (listener) =>
        native.addListener('onKey', (event) => listener(received(event, native))),
    }
  : null;

/** The tvOS Siri Remote directional pan gesture source, or null where unavailable (Android, web). */
export const remotePanGestures: RemotePanGestureSource | null =
  native !== null && typeof native.setPanGestureEnabled === 'function'
    ? {
        setEnabled: (enabled) => {
          native.setPanGestureEnabled?.(Boolean(enabled));
        },
        addListener: (listener) =>
          native.addListener('onPanGesture', (raw) => {
            const event = parsePanGestureEvent(raw);
            if (event !== null) listener(event);
          }),
      }
    : null;
