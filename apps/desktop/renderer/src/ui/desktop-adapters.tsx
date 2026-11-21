import {
  type DeadHostRegistry,
  defaultDeadHostRegistry,
  extractNativeImageError,
  type ImageAdapterProps,
  type UiAdapters,
} from '@elv/ui-kit';
import { Image } from 'react-native';

/**
 * Creates desktop/web {@link UiAdapters} rendering clean RNW `<Image>` elements with structured
 * error propagation into {@link DeadHostRegistry} (`#202`, `#311`).
 */
export function createDesktopUiAdapters(): UiAdapters {
  return {
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
