import { createProfilePreferencesManager, type ProfilePreferencesManager } from '@elv/domain';
import { createDeviceKvBackend } from './kv-backend';

/**
 * Creates the platform-backed {@link ProfilePreferencesManager} for mobile and TV devices (`#15`):
 * - Apple (iOS, iPadOS, tvOS): React Native `Settings` (`NSUserDefaults`), surviving Caches purges.
 * - Android / Fire OS: `expo-secure-store` (payload is ~110 bytes, well below the 2048 B limit).
 * - Other platforms: in-memory KV fallback.
 *
 * Uses strict `[A-Za-z0-9._-]+` keys (`elv.active-profile.v1`, `elv.preferences.v1`,
 * `elv.preferences.v1.<profileId>`) safe across every mobile and TV KV backend.
 */
export function createDevicePreferencesStore(): ProfilePreferencesManager {
  const { backend, persistent } = createDeviceKvBackend();
  return createProfilePreferencesManager(backend, { coalesceMs: persistent ? 500 : 0 });
}
