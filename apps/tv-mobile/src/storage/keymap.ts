import { createKeymapStore, type KeymapStore, type KeymapStoreOptions } from '@elv/domain';
import { createDeviceKvBackend } from './kv-backend';

/**
 * Creates the platform-backed sparse {@link KeymapStore} for mobile and TV devices (`#33`).
 * Persists overrides separately under `elv.keymap.v1` / `elv.keymap.v1.<profileId>` on Apple
 * `Settings`, Android `expo-secure-store`, or an in-memory fallback so `elv.preferences.v1` stays
 * safely under Android SecureStore's 2048 B entry cap.
 */
export function createDeviceKeymapStore(opts?: KeymapStoreOptions): KeymapStore {
  const { backend } = createDeviceKvBackend();
  return createKeymapStore(backend, opts);
}
