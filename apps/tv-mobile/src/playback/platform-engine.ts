import { createAetherEngine } from '@elv/engine-aether';
import { createMedia3Engine, type Media3EngineOptions } from '@elv/engine-media3';
import type { PlayerEngine } from '@elv/playback';

/**
 * Creates the native `PlayerEngine` available on the running platform: AetherEngine on Apple
 * (tvOS, iOS, iPadOS) or Media3 on Android, or `null` where neither native module is linked.
 * Optional `options` forward Multi-View audio focus and tile-count sizing to Media3 (`#34`, `#221`).
 */
export function createPlatformEngine(options?: Media3EngineOptions): PlayerEngine | null {
  return (
    createAetherEngine() ??
    (options === undefined ? createMedia3Engine() : createMedia3Engine(options))
  );
}
