import { createContext, type ReactElement, type ReactNode, useContext } from 'react';
import { Platform, useWindowDimensions } from 'react-native';

/** Target device form factor used for container layout forks. */
export type FormFactor = 'tv' | 'phone' | 'tablet' | 'desktop';

const TABLET_MIN_SHORT_EDGE_DP = 600;

/** Pure form-factor classifier from platform flags and window dimensions. */
export function detectFormFactor(input: {
  isTV: boolean;
  os: string;
  width: number;
  height: number;
}): FormFactor {
  if (input.isTV) return 'tv';
  if (input.os === 'web') return 'desktop';
  if (Math.min(input.width, input.height) >= TABLET_MIN_SHORT_EDGE_DP) return 'tablet';
  return 'phone';
}

const FormFactorContext = createContext<FormFactor | undefined>(undefined);

/** Supplies the active {@link FormFactor} (or an explicit test/container override) to descendants. */
export function FormFactorProvider({
  value,
  children,
}: {
  value?: FormFactor;
  children: ReactNode;
}): ReactElement {
  const { width, height } = useWindowDimensions();
  const resolved =
    value ??
    detectFormFactor({
      isTV: Boolean(Platform.isTV),
      os: Platform.OS,
      width,
      height,
    });
  return <FormFactorContext.Provider value={resolved}>{children}</FormFactorContext.Provider>;
}

/** Reads the active {@link FormFactor}, deriving from platform and window size when outside a provider. */
export function useFormFactor(): FormFactor {
  const provided = useContext(FormFactorContext);
  const { width, height } = useWindowDimensions();
  if (provided !== undefined) return provided;
  return detectFormFactor({
    isTV: Boolean(Platform.isTV),
    os: Platform.OS,
    width,
    height,
  });
}
