import { createContext, type ReactElement, type ReactNode, useContext } from 'react';
import type { ImageResizeMode, ImageStyle, StyleProp, ViewStyle } from 'react-native';
import type { IconSpec } from '../icons/paths';
import type { ArtworkCacheAdapter } from '../primitives/artwork-cache';
import type { ImageErrorInfo } from '../primitives/dead-host-registry';

/** Props passed to an optional native gradient renderer (`expo-linear-gradient`, etc.). */
export interface GradientAdapterProps {
  readonly colors: readonly string[];
  readonly locations?: readonly number[];
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
  readonly style?: StyleProp<ViewStyle>;
  readonly pointerEvents?: 'none' | 'auto' | 'box-none' | 'box-only';
}

/** Props passed to an optional native blur renderer (`expo-blur`, etc.). */
export interface BlurAdapterProps {
  readonly intensity: number;
  readonly tintColor: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: ReactNode;
}

/** Props passed to an optional native image renderer (`expo-image`, etc.) with decode cap (`#311`). */
export interface ImageAdapterProps {
  readonly uri: string;
  readonly resizeMode: ImageResizeMode;
  readonly maxDecodePx?: number;
  readonly style?: StyleProp<ImageStyle>;
  readonly accessibilityLabel?: string;
  readonly onLoad?: () => void;
  readonly onError?: (error?: ImageErrorInfo) => void;
}

/** Props passed to an optional native vector renderer (`react-native-svg`, etc.). */
export interface SvgAdapterProps {
  readonly spec: IconSpec;
  readonly size: number;
  readonly color: string;
  readonly strokeWidth: number;
}

/** Pluggable platform visual adapters keeping `@elv/ui-kit` free of `expo-*` / native modules. */
export interface UiAdapters {
  readonly renderGradient?: (props: GradientAdapterProps) => ReactElement;
  readonly renderBlur?: (props: BlurAdapterProps) => ReactElement;
  readonly renderImage?: (props: ImageAdapterProps) => ReactElement;
  readonly renderSvg?: (props: SvgAdapterProps) => ReactElement;
  readonly artworkCache?: ArtworkCacheAdapter;
  /** True on constrained 2–3 GB TV hardware (e.g. Apple TV `'mid-power'` tier, `#186`, `#414`). */
  readonly lowPowerTier?: boolean;
}

const EMPTY_ADAPTERS: UiAdapters = {};

const UiAdaptersContext = createContext<UiAdapters>(EMPTY_ADAPTERS);

/** Provides optional platform-specific renderers for gradients, blur, images, and vector icons. */
export function UiAdaptersProvider({
  adapters,
  children,
}: {
  adapters: UiAdapters;
  children: ReactNode;
}): ReactElement {
  return <UiAdaptersContext.Provider value={adapters}>{children}</UiAdaptersContext.Provider>;
}

/** Reads the active {@link UiAdapters} overrides (empty defaults outside a provider). */
export function useUiAdapters(): UiAdapters {
  return useContext(UiAdaptersContext);
}
