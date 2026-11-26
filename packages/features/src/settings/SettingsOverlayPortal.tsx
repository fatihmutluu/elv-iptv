import {
  type ComponentRef,
  createContext,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, View } from 'react-native';

/** Bounding rectangle measured relative to the viewport window. */
export interface SettingsOverlayRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Computed positioning for a web/desktop popover inside the Settings root overlay host. */
export interface DropdownPopoverPlacement {
  readonly direction: 'down' | 'up';
  readonly top?: number;
  readonly bottom?: number;
  readonly right: number;
  readonly maxHeight: number;
}

/** Context API for hosting Settings dropdown sheets and popovers above panel `ScrollView`s. */
export interface SettingsOverlayContextValue {
  readonly setOverlay: (id: string, node: ReactElement | null) => void;
  readonly measureHost: () => SettingsOverlayRect | null;
}

interface OverlayEntry {
  readonly id: string;
  readonly node: ReactElement;
}

const POPOVER_GAP = 6;
const POPOVER_OPTION_HEIGHT = 40;
const POPOVER_CHROME_PADDING = 12;
const POPOVER_MAX_HEIGHT = 320;
const POPOVER_MIN_HEIGHT = 120;
const POPOVER_MIN_MARGIN = 12;
const POPOVER_MIN_WIDTH = 220;

class SettingsOverlayStore {
  private readonly entries = new Map<string, ReactElement>();
  private readonly listeners = new Set<() => void>();

  set(id: string, node: ReactElement | null): void {
    if (node === null) {
      if (!this.entries.has(id)) return;
      this.entries.delete(id);
    } else {
      this.entries.set(id, node);
    }
    for (const listener of this.listeners) listener();
  }

  snapshot(): readonly OverlayEntry[] {
    return Array.from(this.entries, ([id, node]) => ({ id, node }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const SettingsOverlayStoreContext = createContext<SettingsOverlayStore | null>(null);
const SettingsOverlayContext = createContext<SettingsOverlayContextValue | null>(null);

/** Reads a web DOM node's viewport rectangle synchronously when available. */
export function measureNodeRect(node: unknown): SettingsOverlayRect | null {
  if (node === null || typeof node !== 'object') return null;
  const candidate = node as {
    getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
  };
  if (typeof candidate.getBoundingClientRect !== 'function') return null;
  const rect = candidate.getBoundingClientRect();
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    (rect.width <= 0 && rect.height <= 0)
  ) {
    return null;
  }
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/**
 * Computes whether a web/desktop dropdown popover should open downward or upward inside
 * `hostRect` so bottom rows (`Guide refresh`, `Speaker channel layout`, `Artwork Cache`)
 * never clip below `ScrollView`.
 */
export function computeDropdownPopoverPlacement(
  triggerRect: SettingsOverlayRect,
  hostRect: SettingsOverlayRect,
  optionCount: number,
): DropdownPopoverPlacement {
  const estimatedHeight = Math.min(
    Math.max(1, optionCount) * POPOVER_OPTION_HEIGHT + POPOVER_CHROME_PADDING,
    POPOVER_MAX_HEIGHT,
  );
  const triggerTop = triggerRect.y - hostRect.y;
  const triggerBottom = triggerTop + triggerRect.height;
  const spaceBelow = Math.max(0, hostRect.height - triggerBottom - POPOVER_MIN_MARGIN);
  const spaceAbove = Math.max(0, triggerTop - POPOVER_MIN_MARGIN);
  const openUpward = spaceBelow < estimatedHeight + POPOVER_GAP && spaceAbove > spaceBelow;
  const rawRight = hostRect.x + hostRect.width - (triggerRect.x + triggerRect.width);
  const maxRight = Math.max(POPOVER_MIN_MARGIN, hostRect.width - POPOVER_MIN_WIDTH);
  const right = Math.max(POPOVER_MIN_MARGIN, Math.min(rawRight, maxRight));

  if (openUpward) {
    const bottom = Math.max(POPOVER_MIN_MARGIN, hostRect.height - triggerTop + POPOVER_GAP);
    return {
      direction: 'up',
      bottom,
      right,
      maxHeight: Math.max(
        POPOVER_MIN_HEIGHT,
        Math.min(POPOVER_MAX_HEIGHT, spaceAbove - POPOVER_GAP),
      ),
    };
  }

  const top = Math.max(POPOVER_MIN_MARGIN, triggerBottom + POPOVER_GAP);
  return {
    direction: 'down',
    top,
    right,
    maxHeight: Math.max(POPOVER_MIN_HEIGHT, Math.min(POPOVER_MAX_HEIGHT, spaceBelow - POPOVER_GAP)),
  };
}

/** Provides a root-level overlay portal scoped to `SettingsScreen` (zero RN `<Modal>`). */
export function SettingsOverlayProvider({
  hostRef,
  children,
}: {
  readonly hostRef: RefObject<ComponentRef<typeof View> | null>;
  readonly children: ReactNode;
}): ReactElement {
  const storeRef = useRef<SettingsOverlayStore | null>(null);
  if (storeRef.current === null) storeRef.current = new SettingsOverlayStore();
  const store = storeRef.current;

  const value = useMemo<SettingsOverlayContextValue>(
    () => ({
      setOverlay: (id, node) => store.set(id, node),
      measureHost: () => measureNodeRect(hostRef.current),
    }),
    [hostRef, store],
  );

  return (
    <SettingsOverlayStoreContext.Provider value={store}>
      <SettingsOverlayContext.Provider value={value}>{children}</SettingsOverlayContext.Provider>
    </SettingsOverlayStoreContext.Provider>
  );
}

/** Returns the active `SettingsScreen` overlay portal context, or `null` when rendered standalone. */
export function useSettingsOverlayPortal(): SettingsOverlayContextValue | null {
  return useContext(SettingsOverlayContext);
}

/** Renders active root-level Settings overlays above the sidebar, header, and panel `ScrollView`. */
export function SettingsOverlayOutlet(): ReactElement | null {
  const store = useContext(SettingsOverlayStoreContext);
  const [entries, setEntries] = useState<readonly OverlayEntry[]>(() => store?.snapshot() ?? []);

  useEffect(() => {
    if (store === null) return undefined;
    setEntries(store.snapshot());
    return store.subscribe(() => {
      setEntries(store.snapshot());
    });
  }, [store]);

  if (entries.length === 0) return null;

  return (
    <View testID="settings-overlay-outlet" pointerEvents="box-none" style={styles.outlet}>
      {entries.map((entry) => (
        <View key={entry.id} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          {entry.node}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  outlet: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 100,
    elevation: 24,
  },
});
