import { createContext, type ReactElement, type ReactNode, useContext } from 'react';
import type { CatalogUiCache } from './catalog-ui-cache';

const CatalogUiCacheContext = createContext<CatalogUiCache | null>(null);

/** Props of {@link CatalogUiCacheProvider}. */
export interface CatalogUiCacheProviderProps {
  readonly cache: CatalogUiCache;
  readonly children: ReactNode;
}

/** Provides a scoped {@link CatalogUiCache} instance to all screens inside `AppShell`. */
export function CatalogUiCacheProvider({
  cache,
  children,
}: CatalogUiCacheProviderProps): ReactElement {
  return <CatalogUiCacheContext.Provider value={cache}>{children}</CatalogUiCacheContext.Provider>;
}

/**
 * Returns the nearest {@link CatalogUiCache} from {@link CatalogUiCacheProvider}, or `null` when
 * a screen is rendered standalone outside `AppShell` (e.g. isolated unit tests).
 */
export function useCatalogUiCache(): CatalogUiCache | null {
  return useContext(CatalogUiCacheContext);
}
