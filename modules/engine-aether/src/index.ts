import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeAetherModule {
  engineVersion(): string;
}

const nativeModule = requireOptionalNativeModule<NativeAetherModule>('ElvEngineAether');

/** The linked AetherEngine version (Apple builds), or null where the native module is absent (Android, web). */
export function aetherEngineVersion(): string | null {
  return nativeModule === null ? null : nativeModule.engineVersion();
}
