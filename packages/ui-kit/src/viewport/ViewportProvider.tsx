import { createContext, type ReactElement, type ReactNode, useContext, useMemo } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { FormFactorContext, FormFactorProvider } from '../form-factor';
import { resolveViewport, type ViewportInfo, type ViewportOverride } from './resolve-viewport';

const ViewportContext = createContext<ViewportInfo | undefined>(undefined);

/** Props of {@link ViewportProvider}. */
export interface ViewportProviderProps {
  /** Partial or full viewport overrides (e.g. device preview frames or unit tests). */
  value?: ViewportOverride;
  children: ReactNode;
}

/**
 * Provides responsive {@link ViewportInfo} (`formFactor`, `orientation`, `inputModality`, overscan,
 * safe area, and rail/grid column counts) and syncs `FormFactorProvider` for legacy callers.
 */
export function ViewportProvider({ value, children }: ViewportProviderProps): ReactElement {
  const { width, height } = useWindowDimensions();
  const oFormFactor = value?.formFactor;
  const oOrientation = value?.orientation;
  const oModality = value?.inputModality;
  const oWidth = value?.width;
  const oHeight = value?.height;
  const oSafeTop = value?.safeArea?.top;
  const oSafeRight = value?.safeArea?.right;
  const oSafeBottom = value?.safeArea?.bottom;
  const oSafeLeft = value?.safeArea?.left;
  const hasOverride = value !== undefined;

  const resolved = useMemo(() => {
    const safeArea =
      oSafeTop !== undefined ||
      oSafeRight !== undefined ||
      oSafeBottom !== undefined ||
      oSafeLeft !== undefined
        ? {
            ...(oSafeTop !== undefined ? { top: oSafeTop } : {}),
            ...(oSafeRight !== undefined ? { right: oSafeRight } : {}),
            ...(oSafeBottom !== undefined ? { bottom: oSafeBottom } : {}),
            ...(oSafeLeft !== undefined ? { left: oSafeLeft } : {}),
          }
        : undefined;
    const override: ViewportOverride | undefined = hasOverride
      ? {
          ...(oFormFactor !== undefined ? { formFactor: oFormFactor } : {}),
          ...(oOrientation !== undefined ? { orientation: oOrientation } : {}),
          ...(oModality !== undefined ? { inputModality: oModality } : {}),
          ...(oWidth !== undefined ? { width: oWidth } : {}),
          ...(oHeight !== undefined ? { height: oHeight } : {}),
          ...(safeArea !== undefined ? { safeArea } : {}),
        }
      : undefined;
    return resolveViewport({
      isTV: Boolean(Platform.isTV),
      os: Platform.OS,
      width,
      height,
      ...(override !== undefined ? { override } : {}),
    });
  }, [
    width,
    height,
    hasOverride,
    oFormFactor,
    oOrientation,
    oModality,
    oWidth,
    oHeight,
    oSafeTop,
    oSafeRight,
    oSafeBottom,
    oSafeLeft,
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
  if (provided !== undefined) return provided;
  return resolveViewport({
    isTV: Boolean(Platform.isTV),
    os: Platform.OS,
    width,
    height,
    ...(legacyFormFactor !== undefined ? { override: { formFactor: legacyFormFactor } } : {}),
  });
}
