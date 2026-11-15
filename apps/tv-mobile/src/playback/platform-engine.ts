import { createAetherEngine } from '@elv/engine-aether';
import { createMedia3Engine } from '@elv/engine-media3';
import type { PlayerEngine } from '@elv/playback';

/**
 * Creates the native `PlayerEngine` available on the running platform: AetherEngine on Apple
 * (tvOS, iOS, iPadOS) or Media3 on Android, or `null` where neither native module is linked.
 */
export function createPlatformEngine(): PlayerEngine | null {
  return createAetherEngine() ?? createMedia3Engine();
}
