import { DEFAULT_USER_DATA_MAX_BYTES, type UserDataStore } from '@elv/data';
import {
  getApplePersistentBudgetBytes,
  readApplePersistentValue,
  writeAppleLocalPersistentValue,
  writeApplePersistentValue,
} from '@elv/engine-aether';
import { Settings } from 'react-native';

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

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

/**
 * Purge-safe Apple user-data store (`#79`, ADR 0014): uses `@elv/engine-aether`'s native
 * `NSUbiquitousKeyValueStore` + `NSUserDefaults` bridge when present (dynamically reading the
 * active 900 KB iCloud KVS or 384 KB local ceiling), mirrors a `<= 384 KB` local copy via
 * `writeLocalFallback`, and never bypasses the 384 KB tvOS `NSUserDefaults` ceiling.
 */
export function createAppleUserDataStore(key: string): UserDataStore {
  const fallback = createSettingsStore(key);
  const writeGuardedSettings = (value: string): void => {
    if (utf8ByteLength(value) <= DEFAULT_USER_DATA_MAX_BYTES) {
      fallback.write(value);
    }
  };
  return {
    get maxBytes(): number {
      return getApplePersistentBudgetBytes() ?? DEFAULT_USER_DATA_MAX_BYTES;
    },
    read() {
      if (getApplePersistentBudgetBytes() !== null) {
        const nativeValue = readApplePersistentValue(key);
        if (nativeValue !== null) return nativeValue;
      }
      return fallback.read();
    },
    write(value) {
      if (getApplePersistentBudgetBytes() !== null) {
        // Native bridge enforces both 900 KB iCloud KVS and 384 KB UserDefaults ceilings; never bypass it.
        writeApplePersistentValue(key, value);
        return;
      }
      writeGuardedSettings(value);
    },
    writeLocalFallback(value) {
      if (utf8ByteLength(value) > DEFAULT_USER_DATA_MAX_BYTES) return;
      if (getApplePersistentBudgetBytes() !== null) {
        writeAppleLocalPersistentValue(key, value);
        return;
      }
      fallback.write(value);
    },
  };
}
