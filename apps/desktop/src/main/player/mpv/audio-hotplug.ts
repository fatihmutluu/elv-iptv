/** Timer callbacks used by `AudioHotplug`. */
export interface HotplugTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Debounced `audio-device-list` watcher that triggers audio output re-initialization on device hotplug (#110). */
export interface AudioHotplug {
  onDeviceList(value: unknown): void;
  reset(): void;
}

const DEFAULT_DEBOUNCE_MS = 500;

function deviceListSignature(list: readonly unknown[]): string {
  const names: string[] = [];
  for (const item of list) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const name = (item as Record<string, unknown>)['name'];
      if (typeof name === 'string') names.push(name);
    }
  }
  return names.join('\0');
}

/** Creates an `AudioHotplug` watcher with a 500 ms debounce window. */
export function createAudioHotplug(opts: {
  timers: HotplugTimers;
  onReinit(): void;
  debounceMs?: number;
}): AudioHotplug {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let lastSignature: string | undefined;
  let timer: unknown;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      opts.timers.clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    onDeviceList(value) {
      if (!Array.isArray(value)) return;
      const sig = deviceListSignature(value);
      if (lastSignature === undefined) {
        lastSignature = sig;
        return;
      }
      if (sig === lastSignature) return;
      lastSignature = sig;
      clearTimer();
      timer = opts.timers.setTimeout(() => {
        timer = undefined;
        opts.onReinit();
      }, debounceMs);
    },
    reset() {
      clearTimer();
      lastSignature = undefined;
    },
  };
}
