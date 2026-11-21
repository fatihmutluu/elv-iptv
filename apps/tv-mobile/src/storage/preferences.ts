import {
  createKvPreferencesStore,
  createMemoryPreferencesStore,
  type PreferencesKvBackend,
  type PreferencesStore,
} from '@elv/domain';
import * as SecureStore from 'expo-secure-store';
import { Platform, Settings } from 'react-native';

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
 * Creates the platform-backed {@link PreferencesStore} for mobile and TV devices:
 * - Apple (iOS, iPadOS, tvOS): React Native `Settings` (`NSUserDefaults`), surviving Caches purges.
 * - Android / Fire OS: `expo-secure-store` (payload is ~110 bytes, well below the 2048 B limit).
 * - Other platforms: in-memory fallback.
 */
export function createDevicePreferencesStore(): PreferencesStore {
  if (Platform.OS === 'ios') {
    return createKvPreferencesStore(createAppleSettingsBackend(), undefined, { coalesceMs: 500 });
  }
  if (Platform.OS === 'android') {
    return createKvPreferencesStore(createAndroidSecureStoreBackend(), undefined, {
      coalesceMs: 500,
    });
  }
  return createMemoryPreferencesStore();
}
