import type { AetherEngineOptions } from '@elv/engine-aether';
import type { Media3EngineOptions } from '@elv/engine-media3';
import type { PlayerEngine } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createAetherEngine, createMedia3Engine } = vi.hoisted(() => ({
  createAetherEngine: vi.fn<(options?: AetherEngineOptions) => PlayerEngine | null>(),
  createMedia3Engine: vi.fn<(options?: Media3EngineOptions) => PlayerEngine | null>(),
}));

vi.mock('@elv/engine-aether', () => ({ createAetherEngine }));
vi.mock('@elv/engine-media3', () => ({ createMedia3Engine }));

import { createPlatformEngine } from './platform-engine';

const fake = (tag: string) => ({ tag }) as unknown as PlayerEngine;

afterEach(() => {
  createAetherEngine.mockReset();
  createMedia3Engine.mockReset();
});

describe('createPlatformEngine', () => {
  it('prefers the Aether engine when available and forwards handleAudioFocus', () => {
    const aether = fake('aether');
    createAetherEngine.mockReturnValue(aether);
    createMedia3Engine.mockReturnValue(fake('media3'));
    expect(createPlatformEngine()).toBe(aether);
    expect(createAetherEngine).toHaveBeenLastCalledWith();
    expect(createMedia3Engine).not.toHaveBeenCalled();

    expect(createPlatformEngine({ handleAudioFocus: false, multiViewTileCount: 4 })).toBe(aether);
    expect(createAetherEngine).toHaveBeenLastCalledWith({ handleAudioFocus: false });
    expect(createMedia3Engine).not.toHaveBeenCalled();
  });

  it('falls back to Media3 when Aether is absent and forwards Multi-View options', () => {
    const media3 = fake('media3');
    createAetherEngine.mockReturnValue(null);
    createMedia3Engine.mockReturnValue(media3);
    expect(createPlatformEngine({ handleAudioFocus: false, multiViewTileCount: 4 })).toBe(media3);
    expect(createMedia3Engine).toHaveBeenCalledWith({
      handleAudioFocus: false,
      multiViewTileCount: 4,
    });
  });

  it('returns null when neither native engine exists', () => {
    createAetherEngine.mockReturnValue(null);
    createMedia3Engine.mockReturnValue(null);
    expect(createPlatformEngine()).toBeNull();
  });
});
