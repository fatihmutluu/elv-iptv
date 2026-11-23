import type { BrowseKind } from '@elv/data';
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
import { countPendingCategories, discoveredCategoryKey } from './category-selection-model';
import type { SourcesController } from './useSourcesController';

type ScrollViewHandle = ComponentRef<typeof ScrollView>;
type ViewHandle = ComponentRef<typeof View>;

const CONTROLS_LIST_ID = 'sources-controls';
const TV_SCROLL_PADDING = 32;
const PICKER_KIND_ORDER: readonly BrowseKind[] = ['live', 'movie', 'series'];

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
  const picker = ctrl.categoryPicker;
  if (picker !== null) {
    const pickerItems: FocusItem[] = [];
    if (!picker.loading && picker.error === null) {
      pickerItems.push(
        {
          id: 'category-select-all',
          kind: 'action',
          rowGroup: 'category-bulk',
          run: ctrl.selectAllCategories,
        },
        {
          id: 'category-clear-all',
          kind: 'action',
          rowGroup: 'category-bulk',
          run: ctrl.clearAllCategories,
        },
      );
      for (const kind of PICKER_KIND_ORDER) {
        for (const cat of picker.categories) {
          if (cat.kind !== kind) continue;
          const key = discoveredCategoryKey(cat.kind, cat.id);
          pickerItems.push({
            id: `category-item-${key}`,
            kind: 'action',
            run: () => ctrl.toggleCategorySelection(key),
          });
        }
      }
    }
    pickerItems.push({
      id: 'category-cancel',
      kind: 'action',
      rowGroup: 'category-footer',
      run: ctrl.closeCategoryPicker,
    });
    if (!picker.loading && picker.error === null) {
      pickerItems.push({
        id: 'category-confirm',
        kind: 'action',
        rowGroup: 'category-footer',
        run: () => void ctrl.confirmCategorySelection(),
      });
    }
    return pickerItems;
  }

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
    if (ctrl.canPasteClipboard) {
      items.push({
        id: 'paste-clipboard',
        kind: 'action',
        rowGroup: 'm3u-import-helpers',
        run: () => void ctrl.pasteFromClipboard(),
      });
    }
    if (ctrl.canPickLocalFile) {
      items.push({
        id: 'choose-local-file',
        kind: 'action',
        rowGroup: 'm3u-import-helpers',
        run: () => void ctrl.pickLocalFile(),
      });
    }
    if (ctrl.form.localFile != null) {
      items.push({
        id: 'clear-local-file',
        kind: 'action',
        run: ctrl.clearLocalFile,
      });
    }
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
      { id: 'input-xmltv-timezone', kind: 'input' },
      {
        id: 'toggle-legacy-tls',
        kind: 'action',
        run: () => ctrl.updateField('allowLegacyTls', !(ctrl.form.allowLegacyTls === true)),
      },
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
  items.push({
    id: 'submit',
    kind: 'action',
    rowGroup: 'submit-actions',
    run: () => void ctrl.submit(),
  });
  if (ctrl.canChooseCategories) {
    items.push({
      id: 'submit-choose-categories',
      kind: 'action',
      rowGroup: 'submit-actions',
      run: () => void ctrl.submit({ chooseCategories: true }),
    });
  }
  for (const source of ctrl.sources) {
    if (countPendingCategories(source.categorySelection) > 0) {
      const pendingGroup = `source-pending-${source.id}`;
      items.push(
        {
          id: `source-include-pending-${source.id}`,
          kind: 'action',
          rowGroup: pendingGroup,
          run: () => void ctrl.includePendingCategories(source),
        },
        {
          id: `source-dismiss-pending-${source.id}`,
          kind: 'action',
          rowGroup: pendingGroup,
          run: () => void ctrl.dismissPendingCategories(source),
        },
      );
    }
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
      if (!source.needsImport && ctrl.canRefreshGuide) {
        items.push({
          id: `source-guide-${source.id}`,
          kind: 'action',
          rowGroup,
          run: () => void ctrl.runGuideRefresh(source.id),
        });
      }
      if (ctrl.canChooseCategories) {
        items.push({
          id: `source-categories-${source.id}`,
          kind: 'action',
          rowGroup,
          run: () => void ctrl.openCategoryPicker(source),
        });
      }
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
  onFocusTopNav,
  suppressTopNav = false,
}: {
  store: FocusStore;
  controls: readonly FocusItem[];
  onSelectIndex: (index: number) => void;
  onBackIntent: () => void;
  onFocusTopNav?: () => void;
  suppressTopNav?: boolean;
}): null {
  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  const selectRef = useRef(onSelectIndex);
  selectRef.current = onSelectIndex;
  const backRef = useRef(onBackIntent);
  backRef.current = onBackIntent;
  const topNavRef = useRef(onFocusTopNav);
  topNavRef.current = onFocusTopNav;
  const suppressTopNavRef = useRef(suppressTopNav);
  suppressTopNavRef.current = suppressTopNav;

  useKeyInterpreter((event) => {
    const items = controlsRef.current;
    store.setCount(CONTROLS_LIST_ID, items.length);
    const intents = store.dispatch(event);
    for (const intent of intents) {
      if (
        intent.kind === 'edge' &&
        intent.side === 'start' &&
        (event.key === 'up' || event.key === 'channelUp')
      ) {
        if (!suppressTopNavRef.current) topNavRef.current?.();
      } else if (intent.kind === 'select' && intent.listId === CONTROLS_LIST_ID) {
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
  onFocusTopNav,
}: {
  isTv: boolean;
  ctrl: SourcesController;
  onOpenMenu?: () => void;
  onBack?: () => void;
  onFocusTopNav?: () => void;
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
  const activeEditingInputId =
    editingInputId !== null && controls.some((c) => c.kind === 'input' && c.id === editingInputId)
      ? editingInputId
      : null;
  editingInputIdRef.current = activeEditingInputId;

  useLayoutEffect(() => {
    if (editingInputId !== null && activeEditingInputId === null) {
      setEditingInputId(null);
    }
  }, [activeEditingInputId, editingInputId]);

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

  const pickerOpen = ctrl.categoryPicker !== null;
  const pickerLoading = ctrl.categoryPicker?.loading ?? false;
  const pickerOpenRef = useRef(pickerOpen);
  pickerOpenRef.current = pickerOpen;
  const closeCategoryPickerRef = useRef(ctrl.closeCategoryPicker);
  closeCategoryPickerRef.current = ctrl.closeCategoryPicker;
  const prevPickerOpenRef = useRef(pickerOpen);
  const prevPickerLoadingRef = useRef(pickerLoading);
  const savedFocusIdBeforePickerRef = useRef<string | null>(null);
  const lastFocusedIdRef = useRef<string | undefined>(undefined);

  const rawFocusedIndex = useSyncExternalStore(
    focusStore.subscribe,
    () => findList(focusStore.getState().scopes, CONTROLS_LIST_ID)?.list.index ?? 0,
    () => 0,
  );
  const focusedIndex =
    controls.length === 0 ? 0 : Math.min(rawFocusedIndex, Math.max(0, controls.length - 1));
  const tvFocusId = isTv ? controls[focusedIndex]?.id : undefined;

  useLayoutEffect(() => {
    focusStore.setCount(CONTROLS_LIST_ID, controls.length);
    if (!prevPickerOpenRef.current && pickerOpen) {
      savedFocusIdBeforePickerRef.current = lastFocusedIdRef.current ?? null;
      focusStore.focus(CONTROLS_LIST_ID, 0);
    } else if (pickerOpen && prevPickerLoadingRef.current && !pickerLoading) {
      focusStore.focus(CONTROLS_LIST_ID, 0);
    } else if (prevPickerOpenRef.current && !pickerOpen) {
      const savedId = savedFocusIdBeforePickerRef.current;
      savedFocusIdBeforePickerRef.current = null;
      if (savedId !== null) {
        const restoredIdx = controls.findIndex((c) => c.id === savedId);
        if (restoredIdx >= 0) focusStore.focus(CONTROLS_LIST_ID, restoredIdx);
      }
    }
    prevPickerOpenRef.current = pickerOpen;
    prevPickerLoadingRef.current = pickerLoading;
  }, [controls, focusStore, pickerLoading, pickerOpen]);

  if (!pickerOpen) {
    lastFocusedIdRef.current = controls[focusedIndex]?.id;
  }

  useLayoutEffect(() => {
    if (!isTv || activeEditingInputId === null) return;
    inputRefs.current.get(activeEditingInputId)?.focus();
  }, [activeEditingInputId, isTv]);

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
    if (pickerOpenRef.current) {
      closeCategoryPickerRef.current();
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
    editingInputId: activeEditingInputId,
    registerRef,
    recordLayout,
    handleEndEditing,
    handleSelectIndex,
    handleBackIntent,
    onFocusTopNav,
  };
}
