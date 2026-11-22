import {
  type AppleHardwareTier,
  getAppleDeviceModel,
  resolveAppleHardwareTier,
} from '@elv/engine-aether';
import {
  type ArtworkCacheAdapter,
  DEFAULT_MAX_DECODE_PX,
  type DeadHostRegistry,
  defaultDeadHostRegistry,
  extractNativeImageError,
  type ImageAdapterProps,
  type UiAdapters,
} from '@elv/ui-kit';
import { type AppStateStatus, Image } from 'react-native';
import { createMobileArtworkCache } from './artwork-cache';

const MIN_DECODE_PX = 32;

function clampDecodePx(maxDecodePx: number | undefined): number {
  const raw = maxDecodePx ?? DEFAULT_MAX_DECODE_PX;
  const safe = Number.isFinite(raw) ? raw : DEFAULT_MAX_DECODE_PX;
  return Math.max(MIN_DECODE_PX, Math.round(safe));
}

/**
 * Creates native mobile/TV {@link UiAdapters} enforcing bounded artwork decode caps (`#311`),
 * zero fade blink on recycled `TvList` rows, structured error extraction for `#202`, and
 * disabling heavy blur on 2–3 GB Apple TV (`'mid-power'`) hardware (`#186`).
 */
export function createMobileTvUiAdapters(options?: {
  readonly hardwareTier?: AppleHardwareTier;
  readonly renderBlur?: UiAdapters['renderBlur'];
  readonly artworkCache?: ArtworkCacheAdapter;
}): UiAdapters {
  const tier = options?.hardwareTier ?? resolveAppleHardwareTier(getAppleDeviceModel());
  const renderBlur = tier === 'mid-power' ? undefined : options?.renderBlur;
  const artworkCache = options?.artworkCache ?? createMobileArtworkCache();
  return {
    artworkCache,
    ...(renderBlur !== undefined ? { renderBlur } : {}),
    renderImage({
      uri,
      resizeMode,
      maxDecodePx,
      style,
      accessibilityLabel,
      onLoad,
      onError,
    }: ImageAdapterProps) {
      const cappedPx = clampDecodePx(maxDecodePx);
      return (
        <Image
          source={{ uri, width: cappedPx, height: cappedPx }}
          resizeMode={resizeMode}
          resizeMethod="resize"
          fadeDuration={0}
          progressiveRenderingEnabled
          {...(accessibilityLabel ? { accessibilityLabel } : { accessible: false })}
          style={style}
          onLoad={onLoad}
          onError={(event) => onError?.(extractNativeImageError(event))}
        />
      );
    },
  };
}

/** Minimal `AppState` surface required by {@link attachAppStateDeadHostReset}. */
export interface AppStateLike {
  readonly currentState: string | null | undefined;
  addEventListener(type: 'change', listener: (state: AppStateStatus) => void): { remove(): void };
}

/**
 * Resets the dead-host circuit breaker when the app returns from `'background'` to `'active'`
 * (including iOS/tvOS `background -> inactive -> active` transitions), allowing hosts that failed
 * while offline to recover immediately (`#202`).
 */
export function attachAppStateDeadHostReset(
  appState: AppStateLike,
  registry: DeadHostRegistry = defaultDeadHostRegistry,
): () => void {
  let wasBackground = appState.currentState === 'background';
  const sub = appState.addEventListener('change', (nextState) => {
    if (nextState === 'background') {
      wasBackground = true;
    } else if (nextState === 'active' && wasBackground) {
      wasBackground = false;
      registry.reset();
    }
  });
  return () => {
    sub.remove();
  };
}
