import type { AudioDeviceInfo } from '../../../shared/player-ipc.ts';

const AUTO_DEVICE = 'auto';
const MAX_DEVICE_NAME_CHARS = 160;
const MAX_DESCRIPTION_CHARS = 256;

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function sanitizeDescription(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  let out = '';
  let lastSpace = false;
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      if (!lastSpace) {
        out += ' ';
        lastSpace = true;
      }
    } else {
      out += raw[i];
      lastSpace = code === 0x20;
    }
  }
  const trimmed = out.trim().slice(0, MAX_DESCRIPTION_CHARS);
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Normalizes mpv's `audio-device-list` property into a clean, deduplicated array (`#408`). */
export function normalizeAudioDeviceList(raw: unknown): readonly AudioDeviceInfo[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const devices: AudioDeviceInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec['name'] !== 'string') continue;
    const name = rec['name'].trim();
    if (name.length === 0 || name.length > MAX_DEVICE_NAME_CHARS || hasControlChar(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    devices.push({
      name,
      description: sanitizeDescription(rec['description'], name),
    });
  }
  return devices;
}

/** Normalizes mpv's `audio-device` property into a safe device id, defaulting to `'auto'` (`#408`). */
export function normalizeActiveAudioDevice(raw: unknown): string {
  if (typeof raw !== 'string') return AUTO_DEVICE;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DEVICE_NAME_CHARS || hasControlChar(trimmed)) {
    return AUTO_DEVICE;
  }
  return trimmed;
}

function sameDeviceList(a: readonly AudioDeviceInfo[], b: readonly AudioDeviceInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.name !== b[i]?.name || a[i]?.description !== b[i]?.description) return false;
  }
  return true;
}

/** Tracks mpv `audio-device-list` and `audio-device` properties and emits deduplicated UI snapshots. */
export interface AudioDeviceTracker {
  onDeviceList(raw: unknown): void;
  onActiveDevice(raw: unknown): void;
  reset(): void;
}

/** Creates an {@link AudioDeviceTracker} that emits only when normalized devices or active selection changes. */
export function createAudioDeviceTracker(
  onChange: (devices: readonly AudioDeviceInfo[], active: string) => void,
): AudioDeviceTracker {
  let devices: readonly AudioDeviceInfo[] = [];
  let active = AUTO_DEVICE;
  let emittedOnce = false;

  const emit = (): void => {
    emittedOnce = true;
    onChange(devices, active);
  };

  return {
    onDeviceList(raw) {
      if (!Array.isArray(raw)) return;
      const next = normalizeAudioDeviceList(raw);
      if (emittedOnce && sameDeviceList(devices, next)) return;
      devices = next;
      emit();
    },
    onActiveDevice(raw) {
      const next = normalizeActiveAudioDevice(raw);
      if (emittedOnce && next === active) return;
      active = next;
      if (emittedOnce || next !== AUTO_DEVICE) emit();
    },
    reset() {
      devices = [];
      active = AUTO_DEVICE;
      emittedOnce = false;
    },
  };
}
