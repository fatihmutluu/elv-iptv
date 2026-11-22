/** Timer callbacks used by `AudioHotplug`. */
export interface HotplugTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Targeted, debounced `audio-device` + `audio-device-list` watcher that triggers audio output
 * re-initialization (`ao-reload`) only when the active output device actually changes or flips presence (#110, #434).
 */
export interface AudioHotplug {
  onActiveDevice(value: unknown): void;
  onDeviceList(value: unknown): void;
  reset(): void;
}

const DEFAULT_DEBOUNCE_MS = 500;
const AUTO_DEVICE = 'auto';

function parseDeviceNames(list: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const item of list) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const name = (item as Record<string, unknown>)['name'];
      if (typeof name === 'string') names.push(name);
    }
  }
  return names;
}

function primaryConcreteDevice(names: readonly string[]): string | undefined {
  for (const name of names) {
    if (name !== AUTO_DEVICE) return name;
  }
  return undefined;
}

/** Creates an `AudioHotplug` watcher with a 500 ms debounce window. */
export function createAudioHotplug(opts: {
  timers: HotplugTimers;
  onReinit(): void;
  debounceMs?: number;
}): AudioHotplug {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let activeDevice = AUTO_DEVICE;
  let initialized = false;
  let lastDevices: readonly string[] | undefined;
  let lastPrimary: string | undefined;
  let lastExplicitPresent: boolean | undefined;
  let timer: unknown;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      opts.timers.clearTimeout(timer);
      timer = undefined;
    }
  };

  const scheduleReinit = (): void => {
    clearTimer();
    timer = opts.timers.setTimeout(() => {
      timer = undefined;
      opts.onReinit();
    }, debounceMs);
  };

  const syncBaseline = (names: readonly string[]): void => {
    if (activeDevice === AUTO_DEVICE) {
      lastPrimary = primaryConcreteDevice(names);
      lastExplicitPresent = undefined;
    } else {
      lastExplicitPresent = names.includes(activeDevice);
      lastPrimary = undefined;
    }
  };

  return {
    onActiveDevice(value) {
      if (typeof value !== 'string' || value.length === 0) return;
      if (value !== activeDevice) {
        clearTimer();
        activeDevice = value;
      }
      if (initialized && lastDevices) syncBaseline(lastDevices);
    },
    onDeviceList(value) {
      if (!Array.isArray(value)) return;
      const names = parseDeviceNames(value);
      lastDevices = names;
      if (!initialized) {
        initialized = true;
        syncBaseline(names);
        return;
      }
      if (activeDevice === AUTO_DEVICE) {
        const primary = primaryConcreteDevice(names);
        if (primary === lastPrimary) return;
        lastPrimary = primary;
        scheduleReinit();
        return;
      }
      const present = names.includes(activeDevice);
      if (present === lastExplicitPresent) return;
      lastExplicitPresent = present;
      scheduleReinit();
    },
    reset() {
      clearTimer();
      activeDevice = AUTO_DEVICE;
      initialized = false;
      lastDevices = undefined;
      lastPrimary = undefined;
      lastExplicitPresent = undefined;
    },
  };
}
