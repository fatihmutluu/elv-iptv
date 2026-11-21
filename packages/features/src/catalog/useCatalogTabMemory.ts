import { useCallback, useMemo, useRef, useState } from 'react';
import { type CatalogTabMemory, EMPTY_CATALOG_MEMORY } from './catalog-model';

/**
 * Controlled-or-uncontrolled tab memory state helper preserving category selection and progressive
 * batch count across tab switches.
 */
export function useCatalogTabMemory(
  memory: CatalogTabMemory | undefined,
  onMemoryChange: ((next: CatalogTabMemory) => void) | undefined,
): {
  readonly memory: CatalogTabMemory;
  readonly updateMemory: (patch: Partial<CatalogTabMemory>) => void;
} {
  const [localMemory, setLocalMemory] = useState<CatalogTabMemory>(
    () => memory ?? EMPTY_CATALOG_MEMORY,
  );
  const activeMemory = onMemoryChange && memory !== undefined ? memory : localMemory;
  const activeMemoryRef = useRef(activeMemory);
  activeMemoryRef.current = activeMemory;

  const updateMemory = useCallback(
    (patch: Partial<CatalogTabMemory>) => {
      const next: CatalogTabMemory = { ...activeMemoryRef.current, ...patch };
      activeMemoryRef.current = next;
      setLocalMemory(next);
      onMemoryChange?.(next);
    },
    [onMemoryChange],
  );

  return useMemo(() => ({ memory: activeMemory, updateMemory }), [activeMemory, updateMemory]);
}
