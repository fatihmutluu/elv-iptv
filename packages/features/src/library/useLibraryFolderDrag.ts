import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  findDropTargetAtPoint,
  GENERAL_LIBRARY_DROP_TARGET_ID,
  isGeneralLibraryDropTarget,
  type LibraryCardItem,
  type LibraryDropRect,
} from './library-model';

export { GENERAL_LIBRARY_DROP_TARGET_ID, type LibraryDropRect };

interface ActiveLibraryFolderDrag {
  readonly item: LibraryCardItem;
  readonly sourceCollectionId: string | null;
}

const DRAG_ACTIVATION_MIN_DY_PX = 10;
const DRAG_VERTICAL_DOMINANCE_RATIO = 1.2;
const HORIZONTAL_SCROLL_CANCEL_DX_PX = 8;
const DRAG_CLICK_SUPPRESS_MS = 250;

/** Options for {@link useLibraryFolderDrag}. */
export interface UseLibraryFolderDragOptions {
  readonly enabled: boolean;
  readonly onMoveToCollection: (item: LibraryCardItem, targetCollectionId: string) => void;
  readonly onRemoveFromCollection: (collectionId: string, itemKey: string) => void;
}

/** Bounding rect or dynamic viewport-rect getter registered for one drop target. */
export type LibraryDropZoneSource = LibraryDropRect | (() => LibraryDropRect | null);

/** Return value of {@link useLibraryFolderDrag}. */
export interface LibraryFolderDragController {
  readonly activeDrag: ActiveLibraryFolderDrag | null;
  readonly hoveredTargetId: string | null;
  readonly registerDropZone: (targetId: string, source: LibraryDropZoneSource | null) => void;
  readonly startCardDrag: (
    item: LibraryCardItem,
    sourceCollectionId: string | null,
    clientX: number,
    clientY: number,
  ) => void;
  readonly wasRecentlyDragging: () => boolean;
}

interface PendingDrag {
  readonly item: LibraryCardItem;
  readonly sourceCollectionId: string | null;
  readonly startX: number;
  readonly startY: number;
  activated: boolean;
}

/**
 * Web/Desktop pointer drag-and-drop controller for moving Movies & Series cards into, between,
 * and out of folder-style collections in `Library -> Following`.
 */
export function useLibraryFolderDrag({
  enabled,
  onMoveToCollection,
  onRemoveFromCollection,
}: UseLibraryFolderDragOptions): LibraryFolderDragController {
  const [activeDrag, setActiveDrag] = useState<ActiveLibraryFolderDrag | null>(null);
  const [hoveredTargetId, setHoveredTargetId] = useState<string | null>(null);
  const [listening, setListening] = useState(false);

  const dropSourcesRef = useRef<Map<string, LibraryDropZoneSource>>(new Map());
  const pendingRef = useRef<PendingDrag | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const lastDragEndAtRef = useRef<number>(0);
  const onMoveRef = useRef(onMoveToCollection);
  onMoveRef.current = onMoveToCollection;
  const onRemoveRef = useRef(onRemoveFromCollection);
  onRemoveRef.current = onRemoveFromCollection;

  const registerDropZone = useCallback((targetId: string, source: LibraryDropZoneSource | null) => {
    if (source === null) {
      dropSourcesRef.current.delete(targetId);
    } else {
      dropSourcesRef.current.set(targetId, source);
    }
  }, []);

  const wasRecentlyDragging = useCallback((): boolean => {
    if (pendingRef.current?.activated) return true;
    const endedAt = lastDragEndAtRef.current;
    return endedAt > 0 && Date.now() - endedAt < DRAG_CLICK_SUPPRESS_MS;
  }, []);

  const startCardDrag = useCallback(
    (
      item: LibraryCardItem,
      sourceCollectionId: string | null,
      clientX: number,
      clientY: number,
    ) => {
      if (!enabled || Platform.OS !== 'web') return;
      if (item.kind !== 'movie' && item.kind !== 'series') return;
      pendingRef.current = {
        item,
        sourceCollectionId,
        startX: clientX,
        startY: clientY,
        activated: false,
      };
      hoveredRef.current = null;
      setListening(true);
    },
    [enabled],
  );

  useEffect(() => {
    if (enabled) return;
    pendingRef.current = null;
    hoveredRef.current = null;
    setListening(false);
    setActiveDrag(null);
    setHoveredTargetId(null);
  }, [enabled]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !listening || !enabled) return undefined;
    const win = globalThis as unknown as {
      addEventListener?: (
        t: string,
        fn: (e: { clientX?: number; clientY?: number }) => void,
      ) => void;
      removeEventListener?: (
        t: string,
        fn: (e: { clientX?: number; clientY?: number }) => void,
      ) => void;
    };
    if (!win.addEventListener || !win.removeEventListener) return undefined;

    const finishDrag = (commit: boolean) => {
      const pending = pendingRef.current;
      const target = hoveredRef.current;
      pendingRef.current = null;
      hoveredRef.current = null;
      if (pending?.activated) {
        lastDragEndAtRef.current = Date.now();
      }
      setListening(false);
      setActiveDrag(null);
      setHoveredTargetId(null);

      if (!commit || !pending?.activated || target === null) return;
      if (isGeneralLibraryDropTarget(target)) {
        if (pending.sourceCollectionId !== null) {
          onRemoveRef.current(pending.sourceCollectionId, pending.item.itemKey);
        }
        return;
      }
      if (target !== pending.sourceCollectionId) {
        onMoveRef.current(pending.item, target);
      }
    };

    const handleMove = (e: { clientX?: number; clientY?: number }) => {
      const pending = pendingRef.current;
      if (!pending) return;
      const x = typeof e.clientX === 'number' ? e.clientX : pending.startX;
      const y = typeof e.clientY === 'number' ? e.clientY : pending.startY;
      if (!pending.activated) {
        const absDx = Math.abs(x - pending.startX);
        const absDy = Math.abs(y - pending.startY);
        if (absDx >= HORIZONTAL_SCROLL_CANCEL_DX_PX && absDx > absDy) {
          finishDrag(false);
          return;
        }
        if (absDy < DRAG_ACTIVATION_MIN_DY_PX || absDy <= absDx * DRAG_VERTICAL_DOMINANCE_RATIO) {
          return;
        }
        pending.activated = true;
        setActiveDrag({ item: pending.item, sourceCollectionId: pending.sourceCollectionId });
      }
      const resolvedRects = new Map<string, LibraryDropRect>();
      for (const [id, src] of dropSourcesRef.current) {
        const rect = typeof src === 'function' ? src() : src;
        if (rect !== null) resolvedRects.set(id, rect);
      }
      const hit = findDropTargetAtPoint(resolvedRects, x, y);
      const validHit =
        hit === null
          ? null
          : isGeneralLibraryDropTarget(hit)
            ? pending.sourceCollectionId !== null
              ? hit
              : null
            : hit !== pending.sourceCollectionId
              ? hit
              : null;
      if (hoveredRef.current !== validHit) {
        hoveredRef.current = validHit;
        setHoveredTargetId(validHit);
      }
    };

    const handleUp = () => finishDrag(true);
    const handleCancel = () => finishDrag(false);
    win.addEventListener('pointermove', handleMove);
    win.addEventListener('pointerup', handleUp);
    win.addEventListener('pointercancel', handleCancel);
    win.addEventListener('blur', handleCancel);
    return () => {
      pendingRef.current = null;
      hoveredRef.current = null;
      win.removeEventListener?.('pointermove', handleMove);
      win.removeEventListener?.('pointerup', handleUp);
      win.removeEventListener?.('pointercancel', handleCancel);
      win.removeEventListener?.('blur', handleCancel);
    };
  }, [enabled, listening]);

  return {
    activeDrag,
    hoveredTargetId,
    registerDropZone,
    startCardDrag,
    wasRecentlyDragging,
  };
}
