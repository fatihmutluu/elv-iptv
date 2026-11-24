import {
  createProfilePreferencesManager,
  type PreferencesKvBackend,
  type ProfilePreferencesManager,
} from '@elv/domain';
import * as SecureStore from 'expo-secure-store';
import { Platform, Settings } from 'react-native';

function createMemoryKvBackend(): PreferencesKvBackend {
  const data = new Map<string, string>();
  return {
    get(key) {
      return data.get(key);
    },
    set(key, value) {
      data.set(key, value);
    },
    delete(key) {
      data.delete(key);
    },
  };
}

function createAppleSettingsBackend(): PreferencesKvBackend {
  return {
    get(key) {
      try {
        const value: unknown = Settings.get(key);
        return typeof value === 'string' ? value : undefined;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      Settings.set({ [key]: value });
    },
    delete(key) {
      Settings.set({ [key]: null });
    },
  };
}

function createAndroidSecureStoreBackend(): PreferencesKvBackend {
  return {
    async get(key) {
      const value = await SecureStore.getItemAsync(key);
      return value ?? undefined;
    },
    async set(key, value) {
      await SecureStore.setItemAsync(key, value);
    },
    async delete(key) {
      await SecureStore.deleteItemAsync(key);
    },
  };
}

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
  if (Platform.OS === 'ios') {
    return createProfilePreferencesManager(createAppleSettingsBackend(), { coalesceMs: 500 });
  }
  if (Platform.OS === 'android') {
    return createProfilePreferencesManager(createAndroidSecureStoreBackend(), { coalesceMs: 500 });
  }
  return createProfilePreferencesManager(createMemoryKvBackend(), { coalesceMs: 0 });
}
