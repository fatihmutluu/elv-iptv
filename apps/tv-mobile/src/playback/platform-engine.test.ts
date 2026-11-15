import type { PlayerEngine } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createAetherEngine, createMedia3Engine } = vi.hoisted(() => ({
  createAetherEngine: vi.fn<() => PlayerEngine | null>(),
  createMedia3Engine: vi.fn<() => PlayerEngine | null>(),
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
  it('prefers the Aether engine when available', () => {
    const aether = fake('aether');
    createAetherEngine.mockReturnValue(aether);
    createMedia3Engine.mockReturnValue(fake('media3'));
    expect(createPlatformEngine()).toBe(aether);
    expect(createMedia3Engine).not.toHaveBeenCalled();
  });

  it('falls back to Media3 when Aether is absent', () => {
    const media3 = fake('media3');
    createAetherEngine.mockReturnValue(null);
    createMedia3Engine.mockReturnValue(media3);
    expect(createPlatformEngine()).toBe(media3);
  });

  it('returns null when neither native engine exists', () => {
    createAetherEngine.mockReturnValue(null);
    createMedia3Engine.mockReturnValue(null);
    expect(createPlatformEngine()).toBeNull();
  });
});
