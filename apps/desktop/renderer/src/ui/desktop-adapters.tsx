import {
  ARTWORK_CACHE_MAX_MB,
  ARTWORK_CACHE_MIN_MB,
  type ArtworkCacheAdapter,
  DEFAULT_ARTWORK_CACHE_MB,
  type DeadHostRegistry,
  defaultDeadHostRegistry,
  defaultLoadedArtworkUris,
  extractNativeImageError,
  type ImageAdapterProps,
  type LoadedUriCache,
  type UiAdapters,
} from '@elv/ui-kit';
import { Image } from 'react-native';
import type { ArtworkBridge } from '../../../src/shared/artwork-ipc.ts';

const BYTES_PER_MIB = 1024 * 1024;
const MIN_LIMIT_BYTES = ARTWORK_CACHE_MIN_MB * BYTES_PER_MIB;
const MAX_LIMIT_BYTES = ARTWORK_CACHE_MAX_MB * BYTES_PER_MIB;
const DEFAULT_LIMIT_BYTES = DEFAULT_ARTWORK_CACHE_MB * BYTES_PER_MIB;

function clampLimitBytes(maxBytes: number): number {
  if (!Number.isFinite(maxBytes)) return DEFAULT_LIMIT_BYTES;
  return Math.max(MIN_LIMIT_BYTES, Math.min(MAX_LIMIT_BYTES, Math.floor(maxBytes)));
}

/** Optional overrides for {@link createDesktopUiAdapters}. */
export interface DesktopUiAdaptersOptions {
  readonly artworkBridge?: ArtworkBridge;
  readonly loadedUris?: LoadedUriCache;
}

/**
 * Creates desktop/web {@link UiAdapters} rendering clean RNW `<Image>` elements with structured
 * error propagation into {@link DeadHostRegistry} (`#202`, `#311`) and IPC-backed artwork cache
 * controls (`#405`).
 */
export function createDesktopUiAdapters(options?: DesktopUiAdaptersOptions): UiAdapters {
  const loadedUris = options?.loadedUris ?? defaultLoadedArtworkUris;
  const resolveBridge = (): ArtworkBridge | undefined =>
    options?.artworkBridge ?? (typeof window !== 'undefined' ? window.elv?.artwork : undefined);
  let fallbackLimitBytes = DEFAULT_LIMIT_BYTES;

  const artworkCache: ArtworkCacheAdapter = {
    async clear(): Promise<void> {
      loadedUris.clear();
      const bridge = resolveBridge();
      if (bridge) await bridge.clear();
    },
    async setLimitBytes(maxBytes: number): Promise<void> {
      const clamped = clampLimitBytes(maxBytes);
      fallbackLimitBytes = clamped;
      const bridge = resolveBridge();
      if (bridge) await bridge.setLimitBytes(clamped);
    },
    async stats() {
      const bridge = resolveBridge();
      if (bridge) return bridge.stats();
      return { bytes: 0, entries: 0, maxBytes: fallbackLimitBytes };
    },
  };

  return {
    artworkCache,
    renderImage({
      uri,
      resizeMode,
      style,
      accessibilityLabel,
      onLoad,
      onError,
    }: ImageAdapterProps) {
      return (
        <Image
          source={{ uri }}
          resizeMode={resizeMode}
          accessibilityLabel={accessibilityLabel}
          style={style}
          onLoad={onLoad}
          onError={(event) => onError?.(extractNativeImageError(event))}
        />
      );
    },
  };
}

/** Minimal `window` surface required by {@link attachDeadHostOnlineReset}. */
export interface OnlineEventTargetLike {
  addEventListener(type: 'online', listener: () => void): void;
  removeEventListener(type: 'online', listener: () => void): void;
}

/**
 * Resets the dead-host circuit breaker whenever the browser/Electron renderer regains network
 * connectivity (`online` event, `#202`).
 */
export function attachDeadHostOnlineReset(
  target: Window | OnlineEventTargetLike,
  registry: DeadHostRegistry = defaultDeadHostRegistry,
): () => void {
  const onOnline = (): void => {
    registry.reset();
  };
  target.addEventListener('online', onOnline);
  return () => {
    target.removeEventListener('online', onOnline);
  };
}
