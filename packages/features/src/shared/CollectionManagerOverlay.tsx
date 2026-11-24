import type { CatalogService, ItemRow, VodCollectionRecord } from '@elv/data';
import type { KeyInput } from '@elv/focus-core';
import {
  CtaButton,
  MicroPill,
  Surface,
  TextEntryBoundary,
  TvFocusAnchor,
  TvTextInput,
  type TvTextInputInstance,
  useI18n,
  useTextEntrySuspension,
  useTheme,
  useTvKeyInterceptor,
  useTvKeySource,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  buildCollectionManagerFocusRows,
  type CollectionManagerItemAction,
  type CollectionManagerRowAction,
  moveCollectionItemOrder,
  moveCollectionOrder,
  stepCollectionManagerFocus,
  validateCollectionNameDraft,
} from './collections-model';
import { type DetailTarget, detailTargetFromItem } from './detail-target';
import { createImeSubmitGuard, isImeComposingEvent } from './ime-guard';

const NOOP_TV_SUBSCRIBER = (): boolean => false;

/** Props of {@link CollectionManagerOverlay}. */
export interface CollectionManagerOverlayProps {
  readonly visible: boolean;
  readonly catalog: CatalogService;
  readonly onMutated?: () => void;
  readonly onOpenDetail?: (target: DetailTarget) => void;
  readonly onClose: () => void;
}

function ManagerTvKeyTrap(p: {
  readonly onBack: () => void;
  readonly onNavigate: (key: KeyInput['key']) => void;
}): ReactElement {
  const textEntry = useTextEntrySuspension();
  const ref = useRef(p);
  ref.current = p;
  useTvKeySource(NOOP_TV_SUBSCRIBER);
  useTvKeyInterceptor((input) => {
    if (textEntry.isActive()) return false;
    if (input.action !== 'down' && input.action !== 'press') return true;
    if (input.key === 'back') ref.current.onBack();
    else ref.current.onNavigate(input.key);
    return true;
  });
  return <TvFocusAnchor testID="collection-manager-tv-focus-anchor" hasTVPreferredFocus />;
}

function inputBoxStyle(theme: ReturnType<typeof useTheme>, focused: boolean, accentBorder = false) {
  const c = theme.colors;
  return [
    styles.input,
    theme.typography.body,
    {
      color: c.textPrimary,
      backgroundColor: focused ? c.focusFill : c.bgCard,
      borderWidth: focused ? theme.focus.ringWidth : 1,
      borderColor: focused ? c.focusRingColor : accentBorder ? c.accent : c.surfaceBorder,
      borderRadius: theme.radius.button,
    },
  ];
}

function SmallBtn(p: {
  readonly testID: string;
  readonly label: string;
  readonly isTv: boolean;
  readonly focused: boolean;
  readonly danger?: boolean;
  readonly onPress: () => void;
}): ReactElement {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <Pressable
      testID={p.testID}
      focusable={!p.isTv}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      onPress={p.onPress}
      style={({ pressed }) => [
        styles.smallBtn,
        webCursorPointer(),
        webTransition(theme, 'background-color, border-color, opacity'),
        {
          borderRadius: theme.radius.button,
          backgroundColor: p.focused ? c.focusFill : c.bgCard,
          borderWidth: p.focused ? theme.focus.ringWidth : 1,
          borderColor: p.focused ? c.focusRingColor : p.danger ? c.liveColor : c.surfaceBorder,
          opacity: pressed ? 0.82 : 1,
        },
      ]}
    >
      <Text
        style={[
          theme.typography.caption,
          { color: p.danger ? c.liveColor : c.textPrimary, fontWeight: p.focused ? '700' : '500' },
        ]}
      >
        {p.label}
      </Text>
    </Pressable>
  );
}

function CollectionManagerOverlayBody({
  visible,
  catalog,
  onMutated,
  onOpenDetail,
  onClose,
}: CollectionManagerOverlayProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const isTv = useViewport().formFactor === 'tv';
  const [collections, setCollections] = useState<readonly VodCollectionRecord[]>([]);
  const [itemsByCol, setItemsByCol] = useState<Record<string, readonly ItemRow[]>>({});
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusedRow, setFocusedRow] = useState(1);
  const [focusedCol, setFocusedCol] = useState(0);

  const mountedRef = useRef(true);
  const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const createInputRef = useRef<TvTextInputInstance | null>(null);
  const editInputRef = useRef<TvTextInputInstance | null>(null);
  const createImeRef = useRef(createImeSubmitGuard());
  const editImeRef = useRef(createImeSubmitGuard());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadCollections = useCallback(async () => {
    const cols = catalog.listCollections ? await catalog.listCollections().catch(() => []) : [];
    if (mountedRef.current) setCollections(cols);
  }, [catalog]);

  const loadItems = useCallback(
    async (colId: string) => {
      if (!catalog.listCollectionItems) return;
      const items = await catalog.listCollectionItems(colId).catch(() => [] as ItemRow[]);
      if (mountedRef.current) setItemsByCol((prev) => ({ ...prev, [colId]: items }));
    },
    [catalog],
  );

  useEffect(() => {
    if (!visible) return;
    setNewName('');
    setEditingId(null);
    setEditDraft('');
    setExpandedId(null);
    setStatusMessage(null);
    setFocusedRow(1);
    setFocusedCol(0);
    createImeRef.current.reset();
    editImeRef.current.reset();
    void loadCollections();
  }, [loadCollections, visible]);

  useEffect(() => {
    if (visible && expandedId !== null) void loadItems(expandedId);
  }, [expandedId, loadItems, visible]);

  const handleBack = useCallback(() => {
    if (editingId !== null) {
      setEditingId(null);
      setEditDraft('');
    } else onClose();
  }, [editingId, onClose]);

  useEffect(() => {
    if (!visible || (Platform.OS as string) !== 'web') return undefined;
    type Evt = {
      key?: string;
      isComposing?: boolean;
      keyCode?: number;
      preventDefault?: () => void;
    };
    const host = globalThis as unknown as {
      addEventListener?: (t: string, fn: (e: Evt) => void) => void;
      removeEventListener?: (t: string, fn: (e: Evt) => void) => void;
    };
    const onKey = (e: Evt) => {
      if (e.key === 'Escape' && !isImeComposingEvent(e)) {
        e.preventDefault?.();
        handleBack();
      }
    };
    host.addEventListener?.('keydown', onKey);
    return () => host.removeEventListener?.('keydown', onKey);
  }, [handleBack, visible]);

  const focusRows = useMemo(
    () =>
      buildCollectionManagerFocusRows({
        collections,
        editingId,
        expandedId,
        itemsByCollectionId: itemsByCol,
      }),
    [collections, editingId, expandedId, itemsByCol],
  );

  useEffect(() => {
    setFocusedRow((prev) => {
      const clamped = Math.min(prev, Math.max(0, focusRows.length - 1));
      const maxCol = Math.max(0, (focusRows[clamped]?.cols.length ?? 1) - 1);
      setFocusedCol((col) => Math.min(col, maxCol));
      return clamped;
    });
  }, [focusRows]);

  const runBusy = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await task();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const markSaved = () => {
    setStatusMessage(i18n.t('collections.saved'));
    onMutated?.();
  };

  const createCollection = () =>
    void runBusy(async () => {
      const valid = validateCollectionNameDraft(newName);
      if (valid === null || !catalog.createCollection) return;
      const res = await catalog.createCollection({ name: valid });
      if (mountedRef.current && res.ok) {
        setNewName('');
        await loadCollections();
        markSaved();
      }
    });

  const saveRename = (colId: string) =>
    void runBusy(async () => {
      const valid = validateCollectionNameDraft(editDraft);
      if (valid === null || !catalog.renameCollection) return;
      const res = await catalog.renameCollection(colId, valid);
      if (mountedRef.current && res.ok) {
        setEditingId(null);
        setEditDraft('');
        await loadCollections();
        markSaved();
      }
    });

  const moveCol = (colId: string, delta: -1 | 1) =>
    void runBusy(async () => {
      const reordered = moveCollectionOrder(collections, colId, delta);
      if (reordered === null || !catalog.reorderCollections) return;
      setCollections(reordered);
      const res = await catalog.reorderCollections(reordered.map((c) => c.id));
      if (!mountedRef.current) return;
      if (res.ok) {
        setCollections(res.value);
        markSaved();
      } else await loadCollections();
    });

  const deleteCol = (colId: string) =>
    void runBusy(async () => {
      if (!catalog.deleteCollection) return;
      const res = await catalog.deleteCollection(colId);
      if (mountedRef.current && res.ok) {
        if (expandedId === colId) setExpandedId(null);
        if (editingId === colId) setEditingId(null);
        await loadCollections();
        markSaved();
      }
    });

  const moveItem = (colId: string, itemKey: string, delta: -1 | 1) =>
    void runBusy(async () => {
      const reordered = moveCollectionItemOrder(itemsByCol[colId] ?? [], itemKey, delta);
      if (reordered === null || !catalog.reorderCollectionItems) return;
      setItemsByCol((prev) => ({ ...prev, [colId]: reordered }));
      const res = await catalog.reorderCollectionItems(
        colId,
        reordered.map((i) => i.key),
      );
      if (!mountedRef.current) return;
      if (res.ok) markSaved();
      else await loadItems(colId);
    });

  const removeItem = (colId: string, itemKey: string) =>
    void runBusy(async () => {
      if (!catalog.removeItemFromCollection) return;
      const res = await catalog.removeItemFromCollection(colId, itemKey);
      if (mountedRef.current && res.ok) {
        await Promise.all([loadItems(colId), loadCollections()]);
        markSaved();
      }
    });

  const openItem = (item: ItemRow) => {
    const target = detailTargetFromItem(item);
    if (!target || !onOpenDetail) return;
    onClose();
    onOpenDetail(target);
  };

  const navState = {
    focusRows,
    focusedRow,
    focusedCol,
    collections,
    itemsByCol,
    onClose,
    createCollection,
    saveRename,
    moveCol,
    deleteCol,
    moveItem,
    removeItem,
    openItem,
  };
  const navRef = useRef(navState);
  navRef.current = navState;

  const handleTvNavigate = useCallback((key: KeyInput['key']) => {
    const s = navRef.current;
    const row = s.focusRows[s.focusedRow];
    if (!row) return;
    if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
      const next = stepCollectionManagerFocus(s.focusRows, s.focusedRow, s.focusedCol, key);
      setFocusedRow(next.row);
      setFocusedCol(next.col);
      if (key === 'up' || key === 'down') {
        scrollRef.current?.scrollTo({ y: Math.max(0, (next.row - 1) * 64), animated: false });
      }
      return;
    }
    if (key !== 'select') return;
    if (row.kind === 'close') s.onClose();
    else if (row.kind === 'create') {
      if (s.focusedCol === 0) createInputRef.current?.focus();
      else s.createCollection();
    } else if (row.kind === 'edit') {
      if (s.focusedCol === 0) editInputRef.current?.focus();
      else if (s.focusedCol === 1) s.saveRename(row.collectionId);
      else {
        setEditingId(null);
        setEditDraft('');
      }
    } else if (row.kind === 'collection') {
      const action = row.cols[s.focusedCol];
      const target = s.collections.find((c) => c.id === row.collectionId);
      if (action === 'expand')
        setExpandedId((prev) => (prev === row.collectionId ? null : row.collectionId));
      else if (action === 'rename' && target) {
        setEditingId(target.id);
        setEditDraft(target.name);
        setFocusedCol(0);
      } else if (action === 'moveUp') s.moveCol(row.collectionId, -1);
      else if (action === 'moveDown') s.moveCol(row.collectionId, 1);
      else if (action === 'delete') s.deleteCol(row.collectionId);
    } else if (row.kind === 'item') {
      const action = row.cols[s.focusedCol];
      const item = (s.itemsByCol[row.collectionId] ?? []).find((i) => i.key === row.itemKey);
      if (action === 'open' && item) s.openItem(item);
      else if (action === 'moveUp') s.moveItem(row.collectionId, row.itemKey, -1);
      else if (action === 'moveDown') s.moveItem(row.collectionId, row.itemKey, 1);
      else if (action === 'remove') s.removeItem(row.collectionId, row.itemKey);
    }
  }, []);

  if (!visible) return null;

  const activeRow = isTv ? (focusRows[focusedRow] ?? null) : null;
  const c = theme.colors;
  const cursor = webCursorPointer();
  const focRing = {
    borderWidth: theme.focus.ringWidth,
    borderColor: c.focusRingColor,
    backgroundColor: c.focusFill,
    borderRadius: theme.radius.button,
    paddingHorizontal: 8,
    paddingVertical: 4,
  };
  const colFoc = (id: string, a: CollectionManagerRowAction) =>
    activeRow?.kind === 'collection' &&
    activeRow.collectionId === id &&
    activeRow.cols[focusedCol] === a;
  const itemFoc = (id: string, k: string, a: CollectionManagerItemAction) =>
    activeRow?.kind === 'item' &&
    activeRow.collectionId === id &&
    activeRow.itemKey === k &&
    activeRow.cols[focusedCol] === a;

  return (
    <View testID="collection-manager-overlay" style={styles.root}>
      {isTv ? <ManagerTvKeyTrap onBack={handleBack} onNavigate={handleTvNavigate} /> : null}
      <Pressable
        testID="collection-manager-backdrop"
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={i18n.t('ui.dismiss')}
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: c.overlayBackdrop }]}
      />
      <View
        testID="collection-manager-sheet"
        style={[
          styles.sheet,
          {
            backgroundColor: c.bgElevated,
            borderColor: c.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={[styles.header, { borderBottomColor: c.surfaceBorder }]}>
          <View style={styles.headerTitles}>
            <Text style={[theme.typography.h2, { color: c.textPrimary }]}>
              {i18n.t('collections.manageTitle')}
            </Text>
            <Text style={[theme.typography.caption, { color: c.textSecondary }]}>
              {i18n.t('collections.subtitle')}
            </Text>
          </View>
          {statusMessage !== null ? (
            <MicroPill testID="collection-manager-status" label={statusMessage} tone="success" />
          ) : null}
          <CtaButton
            testID="collection-manager-close"
            label={i18n.t('collections.close')}
            variant="secondary"
            focusable={!isTv}
            focused={activeRow?.kind === 'close'}
            onPress={onClose}
          />
        </View>
        <View style={[styles.createRow, { borderBottomColor: c.surfaceBorder }]}>
          <TvTextInput
            ref={createInputRef}
            testID="collection-manager-new-input"
            value={newName}
            onChangeText={setNewName}
            placeholder={i18n.t('collections.createPlaceholder')}
            placeholderTextColor={c.textMuted}
            onKeyPress={(e) => createImeRef.current.onKeyPress(e)}
            onSubmitEditing={(e) => {
              if (createImeRef.current.shouldAllowSubmit(e)) createCollection();
            }}
            style={inputBoxStyle(theme, activeRow?.kind === 'create' && focusedCol === 0)}
          />
          <CtaButton
            testID="collection-manager-create-btn"
            label={i18n.t('collections.createAction')}
            variant="primary"
            disabled={busy || validateCollectionNameDraft(newName) === null}
            focusable={!isTv}
            focused={activeRow?.kind === 'create' && focusedCol === 1}
            onPress={createCollection}
          />
        </View>
        <ScrollView
          ref={scrollRef}
          testID="collection-manager-scroll"
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          {...(isTv ? { focusable: false } : {})}
        >
          {collections.length === 0 ? (
            <Text
              testID="collection-manager-empty"
              style={[theme.typography.body, { color: c.textMuted }]}
            >
              {i18n.t('collections.empty')}
            </Text>
          ) : (
            collections.map((col, idx) => {
              const items = itemsByCol[col.id] ?? [];
              const editActive = activeRow?.kind === 'edit' && activeRow.collectionId === col.id;
              return (
                <Surface
                  key={col.id}
                  testID={`collection-manager-row-${col.id}`}
                  tone="surface"
                  bordered
                  rounded="card"
                  style={styles.colCard}
                >
                  {editingId === col.id ? (
                    <View style={styles.editRow}>
                      <TvTextInput
                        ref={editInputRef}
                        testID={`collection-manager-rename-input-${col.id}`}
                        value={editDraft}
                        onChangeText={setEditDraft}
                        placeholder={i18n.t('collections.createPlaceholder')}
                        placeholderTextColor={c.textMuted}
                        onKeyPress={(e) => editImeRef.current.onKeyPress(e)}
                        onSubmitEditing={(e) => {
                          if (editImeRef.current.shouldAllowSubmit(e)) saveRename(col.id);
                        }}
                        style={inputBoxStyle(theme, editActive && focusedCol === 0, true)}
                      />
                      <CtaButton
                        testID={`collection-manager-save-${col.id}`}
                        label={i18n.t('collections.save')}
                        variant="primary"
                        disabled={busy || validateCollectionNameDraft(editDraft) === null}
                        focusable={!isTv}
                        focused={editActive && focusedCol === 1}
                        onPress={() => saveRename(col.id)}
                      />
                      <CtaButton
                        testID={`collection-manager-cancel-${col.id}`}
                        label={i18n.t('collections.cancel')}
                        variant="secondary"
                        focusable={!isTv}
                        focused={editActive && focusedCol === 2}
                        onPress={() => {
                          setEditingId(null);
                          setEditDraft('');
                        }}
                      />
                    </View>
                  ) : (
                    <View style={styles.colHeaderRow}>
                      <Pressable
                        testID={`collection-manager-expand-${col.id}`}
                        focusable={!isTv}
                        accessibilityRole="button"
                        accessibilityLabel={col.name}
                        onPress={() => setExpandedId(expandedId === col.id ? null : col.id)}
                        style={[
                          styles.colTitleBtn,
                          cursor,
                          colFoc(col.id, 'expand') ? focRing : null,
                        ]}
                      >
                        <Text
                          numberOfLines={1}
                          style={[theme.typography.title, { color: c.textPrimary }]}
                        >
                          {col.name}
                        </Text>
                        <MicroPill
                          label={i18n.t('collections.itemCount', { count: col.itemCount })}
                          tone="neutral"
                        />
                      </Pressable>
                      <View style={styles.actionsRow}>
                        <SmallBtn
                          testID={`collection-manager-rename-${col.id}`}
                          label={i18n.t('collections.rename')}
                          isTv={isTv}
                          focused={colFoc(col.id, 'rename')}
                          onPress={() => {
                            setEditingId(col.id);
                            setEditDraft(col.name);
                          }}
                        />
                        {idx > 0 ? (
                          <SmallBtn
                            testID={`collection-manager-move-up-${col.id}`}
                            label={i18n.t('collections.moveUp')}
                            isTv={isTv}
                            focused={colFoc(col.id, 'moveUp')}
                            onPress={() => moveCol(col.id, -1)}
                          />
                        ) : null}
                        {idx < collections.length - 1 ? (
                          <SmallBtn
                            testID={`collection-manager-move-down-${col.id}`}
                            label={i18n.t('collections.moveDown')}
                            isTv={isTv}
                            focused={colFoc(col.id, 'moveDown')}
                            onPress={() => moveCol(col.id, 1)}
                          />
                        ) : null}
                        <SmallBtn
                          testID={`collection-manager-delete-${col.id}`}
                          label={i18n.t('collections.delete')}
                          isTv={isTv}
                          focused={colFoc(col.id, 'delete')}
                          danger
                          onPress={() => deleteCol(col.id)}
                        />
                      </View>
                    </View>
                  )}
                  {expandedId === col.id ? (
                    <View
                      testID={`collection-manager-items-${col.id}`}
                      style={[styles.itemsWrap, { borderTopColor: c.surfaceBorder }]}
                    >
                      {items.length === 0 ? (
                        <Text style={[theme.typography.caption, { color: c.textMuted }]}>
                          {i18n.t('collections.emptyCollection')}
                        </Text>
                      ) : (
                        items.map((item, itemIdx) => (
                          <View
                            key={item.key}
                            testID={`collection-manager-item-${col.id}-${item.key}`}
                            style={styles.itemRow}
                          >
                            <Pressable
                              testID={`collection-manager-open-item-${col.id}-${item.key}`}
                              focusable={!isTv}
                              accessibilityRole="button"
                              accessibilityLabel={item.name}
                              onPress={() => openItem(item)}
                              style={[
                                styles.itemTitleBtn,
                                cursor,
                                itemFoc(col.id, item.key, 'open') ? focRing : null,
                              ]}
                            >
                              <Text
                                numberOfLines={1}
                                style={[theme.typography.body, { color: c.textPrimary }]}
                              >
                                {item.name}
                              </Text>
                            </Pressable>
                            <View style={styles.actionsRow}>
                              {itemIdx > 0 ? (
                                <SmallBtn
                                  testID={`collection-manager-item-up-${col.id}-${item.key}`}
                                  label={i18n.t('collections.moveUp')}
                                  isTv={isTv}
                                  focused={itemFoc(col.id, item.key, 'moveUp')}
                                  onPress={() => moveItem(col.id, item.key, -1)}
                                />
                              ) : null}
                              {itemIdx < items.length - 1 ? (
                                <SmallBtn
                                  testID={`collection-manager-item-down-${col.id}-${item.key}`}
                                  label={i18n.t('collections.moveDown')}
                                  isTv={isTv}
                                  focused={itemFoc(col.id, item.key, 'moveDown')}
                                  onPress={() => moveItem(col.id, item.key, 1)}
                                />
                              ) : null}
                              <SmallBtn
                                testID={`collection-manager-item-remove-${col.id}-${item.key}`}
                                label={i18n.t('collections.removeItem')}
                                isTv={isTv}
                                focused={itemFoc(col.id, item.key, 'remove')}
                                danger
                                onPress={() => removeItem(col.id, item.key)}
                              />
                            </View>
                          </View>
                        ))
                      )}
                    </View>
                  ) : null}
                </Surface>
              );
            })
          )}
        </ScrollView>
      </View>
    </View>
  );
}

/**
 * In-tree Cinema Quietude v2 manager overlay for creating, renaming, reordering, inspecting, and
 * deleting custom VOD collections (`#403`). Never uses React Native `<Modal>`.
 */
export function CollectionManagerOverlay(
  props: CollectionManagerOverlayProps,
): ReactElement | null {
  if (!props.visible) return null;
  return (
    <TextEntryBoundary>
      <CollectionManagerOverlayBody {...props} />
    </TextEntryBoundary>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 60,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: { width: '100%', maxWidth: 720, maxHeight: '86%', borderWidth: 1, overflow: 'hidden' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitles: { flex: 1, minWidth: 0, gap: 2 },
  createRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  input: { flex: 1, minWidth: 160, minHeight: 40, paddingHorizontal: 12, paddingVertical: 8 },
  scroll: { maxHeight: 440 },
  scrollContent: { padding: 20, gap: 12 },
  colCard: { padding: 14, gap: 10 },
  colHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
  },
  colTitleBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 160 },
  actionsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  smallBtn: {
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemsWrap: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 8 },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
  },
  itemTitleBtn: { flex: 1, minWidth: 140, paddingVertical: 4 },
});
