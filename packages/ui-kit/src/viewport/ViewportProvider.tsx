import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { FormFactorContext, FormFactorProvider } from '../form-factor';
import {
  type EdgeInsets,
  resolveViewport,
  type ViewportInfo,
  type ViewportOverride,
} from './resolve-viewport';
import { edgeInsetsEqual, subscribeWebSafeArea } from './web-safe-area';

const ViewportContext = createContext<ViewportInfo | undefined>(undefined);

/** Props of {@link ViewportProvider}. */
export interface ViewportProviderProps {
  /** Partial or full viewport overrides (e.g. device preview frames or unit tests). */
  value?: ViewportOverride;
  /** Optional TV horizontal overscan inset ratio (`0..0.1`, default `0.05`). Ignored on non-TV. */
  overscanX?: number;
  /** Optional TV vertical overscan inset ratio (`0..0.1`, default `0.05`). Ignored on non-TV. */
  overscanY?: number;
  children: ReactNode;
}

/**
 * Provides responsive {@link ViewportInfo} (`formFactor`, `orientation`, `inputModality`, overscan,
 * safe area, and rail/grid column counts) and syncs `FormFactorProvider` for legacy callers.
 */
export function ViewportProvider({
  value,
  overscanX,
  overscanY,
  children,
}: ViewportProviderProps): ReactElement {
  const { width, height } = useWindowDimensions();
  const [probedSafeArea, setProbedSafeArea] = useState<EdgeInsets | undefined>(undefined);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    return subscribeWebSafeArea((next) => {
      setProbedSafeArea((prev) =>
        prev !== undefined && edgeInsetsEqual(prev, next) ? prev : next,
      );
    });
  }, []);

  const oFormFactor = value?.formFactor;
  const oOrientation = value?.orientation;
  const oModality = value?.inputModality;
  const oWidth = value?.width;
  const oHeight = value?.height;
  const oSafeTop = value?.safeArea?.top;
  const oSafeRight = value?.safeArea?.right;
  const oSafeBottom = value?.safeArea?.bottom;
  const oSafeLeft = value?.safeArea?.left;
  const oOverscanEnabled = value?.overscanEnabled;
  const oOverscanX = value?.overscanX;
  const oOverscanY = value?.overscanY;
  const hasOverride = value !== undefined;

  const resolved = useMemo(() => {
    const safeArea =
      probedSafeArea !== undefined ||
      oSafeTop !== undefined ||
      oSafeRight !== undefined ||
      oSafeBottom !== undefined ||
      oSafeLeft !== undefined
        ? {
            top: oSafeTop ?? probedSafeArea?.top ?? 0,
            right: oSafeRight ?? probedSafeArea?.right ?? 0,
            bottom: oSafeBottom ?? probedSafeArea?.bottom ?? 0,
            left: oSafeLeft ?? probedSafeArea?.left ?? 0,
          }
        : undefined;
    const override: ViewportOverride | undefined =
      hasOverride || safeArea !== undefined
        ? {
            ...(oFormFactor !== undefined ? { formFactor: oFormFactor } : {}),
            ...(oOrientation !== undefined ? { orientation: oOrientation } : {}),
            ...(oModality !== undefined ? { inputModality: oModality } : {}),
            ...(oWidth !== undefined ? { width: oWidth } : {}),
            ...(oHeight !== undefined ? { height: oHeight } : {}),
            ...(safeArea !== undefined ? { safeArea } : {}),
            ...(oOverscanEnabled !== undefined ? { overscanEnabled: oOverscanEnabled } : {}),
            ...(oOverscanX !== undefined ? { overscanX: oOverscanX } : {}),
            ...(oOverscanY !== undefined ? { overscanY: oOverscanY } : {}),
          }
        : undefined;
    return resolveViewport({
      isTV: Boolean(Platform.isTV),
      os: Platform.OS,
      width,
      height,
      ...(overscanX !== undefined ? { overscanX } : {}),
      ...(overscanY !== undefined ? { overscanY } : {}),
      ...(override !== undefined ? { override } : {}),
    });
  }, [
    width,
    height,
    overscanX,
    overscanY,
    hasOverride,
    probedSafeArea,
    oFormFactor,
    oOrientation,
    oModality,
    oWidth,
    oHeight,
    oSafeTop,
    oSafeRight,
    oSafeBottom,
    oSafeLeft,
    oOverscanEnabled,
    oOverscanX,
    oOverscanY,
  ]);
  return (
    <ViewportContext.Provider value={resolved}>
      <FormFactorProvider value={resolved.formFactor}>{children}</FormFactorProvider>
    </ViewportContext.Provider>
  );
}

/** Reads the active {@link ViewportInfo}, deriving from live window metrics when outside a provider. */
export function useViewport(): ViewportInfo {
  const provided = useContext(ViewportContext);
  const legacyFormFactor = useContext(FormFactorContext);
  const { width, height } = useWindowDimensions();
  const fallback = useMemo(
    () =>
      provided !== undefined
        ? provided
        : resolveViewport({
            isTV: Boolean(Platform.isTV),
            os: Platform.OS,
            width,
            height,
            ...(legacyFormFactor !== undefined
              ? { override: { formFactor: legacyFormFactor } }
              : {}),
          }),
    [provided, width, height, legacyFormFactor],
  );
  return fallback;
}
