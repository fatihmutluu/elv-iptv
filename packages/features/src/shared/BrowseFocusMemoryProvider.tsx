import { createContext, type ReactElement, type ReactNode, useContext, useRef } from 'react';
import { type BrowseFocusMemory, createBrowseFocusMemory } from './browse-focus-memory';

const BrowseFocusMemoryContext = createContext<BrowseFocusMemory | null>(null);

/** Props of {@link BrowseFocusMemoryProvider}. */
export interface BrowseFocusMemoryProviderProps {
  readonly memory?: BrowseFocusMemory;
  readonly children: ReactNode;
}

/** Provides a scoped {@link BrowseFocusMemory} store to browse screens inside `AppShell` (`#440`). */
export function BrowseFocusMemoryProvider({
  memory,
  children,
}: BrowseFocusMemoryProviderProps): ReactElement {
  const fallbackRef = useRef<BrowseFocusMemory | null>(null);
  if (memory === undefined && fallbackRef.current === null) {
    fallbackRef.current = createBrowseFocusMemory();
  }
  const value = memory ?? fallbackRef.current;
  return (
    <BrowseFocusMemoryContext.Provider value={value}>{children}</BrowseFocusMemoryContext.Provider>
  );
}

/**
 * Returns the nearest {@link BrowseFocusMemory} from {@link BrowseFocusMemoryProvider}, or `null`
 * when a screen is rendered standalone outside `AppShell`.
 */
export function useBrowseFocusMemory(): BrowseFocusMemory | null {
  return useContext(BrowseFocusMemoryContext);
}
