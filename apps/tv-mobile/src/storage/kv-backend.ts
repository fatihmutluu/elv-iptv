import type { PreferencesKvBackend } from '@elv/domain';
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
 * Selects the persistent KV backend for the active mobile/TV platform:
 * - Apple (iOS, iPadOS, tvOS): React Native `Settings` (`NSUserDefaults`).
 * - Android / Fire OS: `expo-secure-store` (each entry must stay under 2048 B).
 * - Other platforms: in-memory fallback.
 */
export function createDeviceKvBackend(): {
  readonly backend: PreferencesKvBackend;
  readonly persistent: boolean;
} {
  if (Platform.OS === 'ios') {
    return { backend: createAppleSettingsBackend(), persistent: true };
  }
  if (Platform.OS === 'android') {
    return { backend: createAndroidSecureStoreBackend(), persistent: true };
  }
  return { backend: createMemoryKvBackend(), persistent: false };
}
