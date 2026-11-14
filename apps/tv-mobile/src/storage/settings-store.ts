import { Settings } from 'react-native';

/**
 * One string under `key` in React Native `Settings` (`NSUserDefaults` on iOS, iPadOS and tvOS, which keeps it across a
 * purge of the caches; tvOS allows an app about 500 KB there). Apple platforms only. A missing settings module or a
 * failed write reads as nothing and never throws.
 */
export function createSettingsStore(key: string): {
  read(): string | undefined;
  write(value: string): void;
} {
  return {
    read() {
      try {
        const value: unknown = Settings.get(key);
        return typeof value === 'string' ? value : undefined;
      } catch {
        return undefined;
      }
    },
    write(value) {
      try {
        Settings.set({ [key]: value });
      } catch {
        // the manifest is a recovery aid; the catalog works without it
      }
    },
  };
}
