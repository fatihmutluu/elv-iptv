import { createFocusStore, type FocusStore, findList } from '@elv/focus-core';
import { type TvTextInputInstance, useKeyInterpreter } from '@elv/ui-kit';
import {
  type ComponentRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { LayoutChangeEvent, ScrollView, View } from 'react-native';
import type { SourcesController } from './useSourcesController';

type ScrollViewHandle = ComponentRef<typeof ScrollView>;
type ViewHandle = ComponentRef<typeof View>;

const CONTROLS_LIST_ID = 'sources-controls';
const TV_SCROLL_PADDING = 32;

type FocusItem =
  | {
      readonly id: string;
      readonly kind: 'action';
      readonly rowGroup?: string;
      readonly run: () => void;
    }
  | { readonly id: string; readonly kind: 'input'; readonly rowGroup?: string };

export type ControlLayoutRecorder = (
  focusId: string,
  node: ViewHandle | null,
  event?: LayoutChangeEvent,
) => void;

function buildSourcesFocusItems(
  ctrl: SourcesController,
  onOpenMenu: (() => void) | undefined,
): readonly FocusItem[] {
  const items: FocusItem[] = [];
  if (onOpenMenu !== undefined) {
    items.push({ id: 'open-menu', kind: 'action', run: onOpenMenu });
  }
  items.push(
    { id: 'mode-xtream', kind: 'action', rowGroup: 'mode', run: () => ctrl.setMode('xtream') },
    { id: 'mode-m3u', kind: 'action', rowGroup: 'mode', run: () => ctrl.setMode('m3u') },
    { id: 'input-name', kind: 'input' },
  );
  if (ctrl.form.mode === 'xtream') {
    items.push(
      { id: 'input-server', kind: 'input' },
      { id: 'input-username', kind: 'input' },
      { id: 'input-password', kind: 'input' },
    );
  } else {
    items.push({ id: 'input-playlist-url', kind: 'input' });
    if (ctrl.detectedXtreamInM3u) {
      items.push({
        id: 'toggle-keep-m3u',
        kind: 'action',
        run: () => ctrl.updateField('keepAsM3u', !ctrl.form.keepAsM3u),
      });
    }
  }
  items.push({ id: 'toggle-advanced', kind: 'action', run: ctrl.toggleAdvanced });
  if (ctrl.showAdvanced) {
    items.push(
      { id: 'input-guide-url', kind: 'input' },
      { id: 'input-user-agent', kind: 'input' },
      { id: 'input-referer', kind: 'input' },
    );
    if (ctrl.form.mode === 'xtream') {
      items.push(
        {
          id: 'format-default',
          kind: 'action',
          rowGroup: 'format',
          run: () => ctrl.updateField('xtreamFormat', 'default'),
        },
        {
          id: 'format-ts',
          kind: 'action',
          rowGroup: 'format',
          run: () => ctrl.updateField('xtreamFormat', 'ts'),
        },
        {
          id: 'format-m3u8',
          kind: 'action',
          rowGroup: 'format',
          run: () => ctrl.updateField('xtreamFormat', 'm3u8'),
        },
      );
    }
  }
  items.push({ id: 'submit', kind: 'action', run: () => void ctrl.submit() });
  for (const source of ctrl.sources) {
    const status = ctrl.statusById[source.id];
    const rowGroup = `source-actions-${source.id}`;
    if (status?.kind === 'importing') {
      items.push({
        id: `source-cancel-${source.id}`,
        kind: 'action',
        rowGroup,
        run: () => ctrl.cancelImport(source.id),
      });
    } else {
      items.push({
        id: `source-sync-${source.id}`,
        kind: 'action',
        rowGroup,
        run: () => void ctrl.runImport(source.id),
      });
    }
    items.push({
      id: `source-remove-${source.id}`,
      kind: 'action',
      rowGroup,
      run: () => void ctrl.remove(source.id),
    });
  }
  return items;
}

export function TvRemoteBridge({
  store,
  controls,
  onSelectIndex,
  onBackIntent,
}: {
  store: FocusStore;
  controls: readonly FocusItem[];
  onSelectIndex: (index: number) => void;
  onBackIntent: () => void;
}): null {
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const selectRef = useRef(onSelectIndex);
  selectRef.current = onSelectIndex;
  const backRef = useRef(onBackIntent);
  backRef.current = onBackIntent;

  useKeyInterpreter((event) => {
    const items = controlsRef.current;
    store.setCount(CONTROLS_LIST_ID, items.length);
    const intents = store.dispatch(event);
    for (const intent of intents) {
      if (intent.kind === 'select' && intent.listId === CONTROLS_LIST_ID) {
        selectRef.current(intent.index);
      } else if (intent.kind === 'back') {
        backRef.current();
      } else if (
        intent.kind === 'key' &&
        (intent.event.kind === 'press' || intent.event.kind === 'repeat') &&
        (intent.event.key === 'left' || intent.event.key === 'right')
      ) {
        const curIdx = findList(store.getState().scopes, CONTROLS_LIST_ID)?.list.index ?? 0;
        const delta = intent.event.key === 'right' ? 1 : -1;
        const curGroup = items[curIdx]?.rowGroup;
        if (curGroup !== undefined && items[curIdx + delta]?.rowGroup === curGroup) {
          store.focus(CONTROLS_LIST_ID, curIdx + delta);
        }
      }
    }
  });

  return null;
}

export function useTvSourcesNavigation({
  isTv,
  ctrl,
  onOpenMenu,
  onBack,
}: {
  isTv: boolean;
  ctrl: SourcesController;
  onOpenMenu?: () => void;
  onBack?: () => void;
}) {
  const inputRefs = useRef<Map<string, TvTextInputInstance>>(new Map());
  const scrollRef = useRef<ScrollViewHandle | null>(null);
  const contentRootRef = useRef<ViewHandle | null>(null);
  const controlNodesRef = useRef<Map<string, ViewHandle>>(new Map());
  const controlLayoutsRef = useRef<Map<string, { y: number; height: number }>>(new Map());
  const viewportHeightRef = useRef(0);
  const scrollYRef = useRef(0);

  const [editingInputId, setEditingInputId] = useState<string | null>(null);
  const editingInputIdRef = useRef<string | null>(null);
  editingInputIdRef.current = editingInputId;

  const registerRef = useCallback((id: string, node: TvTextInputInstance | null) => {
    if (node === null) inputRefs.current.delete(id);
    else inputRefs.current.set(id, node);
  }, []);

  const recordLayout: ControlLayoutRecorder = useCallback(
    (focusId: string, node: ViewHandle | null, event?: LayoutChangeEvent) => {
      if (node !== null) controlNodesRef.current.set(focusId, node);
      if (event !== undefined) {
        const { y, height } = event.nativeEvent.layout;
        controlLayoutsRef.current.set(focusId, { y, height });
      }
    },
    [],
  );

  const controls = useMemo(() => buildSourcesFocusItems(ctrl, onOpenMenu), [ctrl, onOpenMenu]);

  const focusStore = useMemo(
    () =>
      createFocusStore({
        id: 'sources-scope',
        lists: [
          {
            id: CONTROLS_LIST_ID,
            count: 8,
            index: 0,
            orientation: 'vertical',
            pageSize: 5,
          },
        ],
        active: CONTROLS_LIST_ID,
      }),
    [],
  );

  useLayoutEffect(() => {
    focusStore.setCount(CONTROLS_LIST_ID, controls.length);
  }, [controls.length, focusStore]);

  const rawFocusedIndex = useSyncExternalStore(
    focusStore.subscribe,
    () => findList(focusStore.getState().scopes, CONTROLS_LIST_ID)?.list.index ?? 0,
    () => 0,
  );
  const focusedIndex =
    controls.length === 0 ? 0 : Math.min(rawFocusedIndex, Math.max(0, controls.length - 1));
  const tvFocusId = isTv ? controls[focusedIndex]?.id : undefined;

  useLayoutEffect(() => {
    if (!isTv || editingInputId === null) return;
    inputRefs.current.get(editingInputId)?.focus();
  }, [editingInputId, isTv]);

  useLayoutEffect(() => {
    if (!isTv || tvFocusId === undefined) return;
    const applyScroll = (y: number, height: number): void => {
      const vh = viewportHeightRef.current;
      if (vh <= 0) return;
      const curY = scrollYRef.current;
      if (focusedIndex === 0 && curY > 0) {
        scrollYRef.current = 0;
        scrollRef.current?.scrollTo({ y: 0, animated: false });
        return;
      }
      if (y - TV_SCROLL_PADDING < curY) {
        const nextY = Math.max(0, y - TV_SCROLL_PADDING);
        scrollYRef.current = nextY;
        scrollRef.current?.scrollTo({ y: nextY, animated: false });
      } else if (y + height + TV_SCROLL_PADDING > curY + vh) {
        const nextY = Math.max(0, y + height + TV_SCROLL_PADDING - vh);
        scrollYRef.current = nextY;
        scrollRef.current?.scrollTo({ y: nextY, animated: false });
      }
    };

    const node = controlNodesRef.current.get(tvFocusId);
    const rootNode = contentRootRef.current;
    let measured = false;
    if (node && rootNode && typeof node.measureLayout === 'function') {
      try {
        node.measureLayout(
          rootNode,
          (_x, y, _w, height) => {
            measured = true;
            applyScroll(y, height);
          },
          () => undefined,
        );
      } catch {
        // Fallback to cached onLayout coordinates when host lacks measureLayout
      }
    }
    if (!measured) {
      const cached = controlLayoutsRef.current.get(tvFocusId);
      if (cached !== undefined) applyScroll(cached.y, cached.height);
    }
  }, [focusedIndex, isTv, tvFocusId]);

  const handleEndEditing = useCallback((focusId: string) => {
    setEditingInputId((curr) => (curr === focusId ? null : curr));
  }, []);

  const handleSelectIndex = useCallback(
    (index: number) => {
      const target = controls[index];
      if (target === undefined) return;
      if (target.kind === 'action') target.run();
      else {
        setEditingInputId(target.id);
        inputRefs.current.get(target.id)?.focus();
      }
    },
    [controls],
  );

  const handleBackIntent = useCallback(() => {
    const activeInput = editingInputIdRef.current;
    if (activeInput !== null) {
      inputRefs.current.get(activeInput)?.blur();
      setEditingInputId(null);
      return;
    }
    (onBack ?? onOpenMenu)?.();
  }, [onBack, onOpenMenu]);

  return {
    scrollRef,
    contentRootRef,
    viewportHeightRef,
    scrollYRef,
    focusStore,
    controls,
    tvFocusId,
    editingInputId,
    registerRef,
    recordLayout,
    handleEndEditing,
    handleSelectIndex,
    handleBackIntent,
  };
}
