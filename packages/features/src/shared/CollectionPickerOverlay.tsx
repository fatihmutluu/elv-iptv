import type { CatalogService, VodCollectionRecord } from '@elv/data';
import type { KeyInput } from '@elv/focus-core';
import {
  CtaButton,
  Icon,
  MicroPill,
  TABULAR_NUMS_STYLE,
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
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  applyCollectionMembershipDelta,
  buildCollectionPickerFocusRows,
  toggleMembershipSet,
  validateCollectionNameDraft,
} from './collections-model';
import { createImeSubmitGuard, isImeComposingEvent } from './ime-guard';

const NOOP_TV_SUBSCRIBER = (): boolean => false;

/** Props of {@link CollectionPickerOverlay}. */
export interface CollectionPickerOverlayProps {
  readonly visible: boolean;
  readonly catalog: CatalogService;
  readonly itemKey: string;
  readonly itemKind: 'movie' | 'series';
  readonly itemTitle: string;
  readonly onMutated?: (memberCollectionIds: readonly string[]) => void;
  readonly onClose: () => void;
}

function PickerTvKeyTrap({
  onBack,
  onNavigate,
}: {
  readonly onBack: () => void;
  readonly onNavigate: (key: KeyInput['key']) => void;
}): ReactElement {
  const textEntry = useTextEntrySuspension();
  const callbacksRef = useRef({ onBack, onNavigate });
  callbacksRef.current = { onBack, onNavigate };

  useTvKeySource(NOOP_TV_SUBSCRIBER);
  useTvKeyInterceptor((input) => {
    if (textEntry.isActive()) return false;
    if (input.action !== 'down' && input.action !== 'press') return true;
    if (input.key === 'back') {
      callbacksRef.current.onBack();
      return true;
    }
    callbacksRef.current.onNavigate(input.key);
    return true;
  });

  return <TvFocusAnchor testID="collection-picker-tv-focus-anchor" hasTVPreferredFocus />;
}

function CollectionPickerOverlayBody({
  visible,
  catalog,
  itemKey,
  itemKind,
  itemTitle,
  onMutated,
  onClose,
}: CollectionPickerOverlayProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';

  const [collections, setCollections] = useState<readonly VodCollectionRecord[]>([]);
  const [memberIds, setMemberIds] = useState<ReadonlySet<string>>(() => new Set());
  const [draftName, setDraftName] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusedRow, setFocusedRow] = useState(1);
  const [focusedCol, setFocusedCol] = useState(0);

  const mountedRef = useRef(true);
  const inputRef = useRef<TvTextInputInstance | null>(null);
  const imeGuardRef = useRef(createImeSubmitGuard());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadState = useCallback(async () => {
    const [cols, existingIds] = await Promise.all([
      catalog.listCollections ? catalog.listCollections().catch(() => []) : Promise.resolve([]),
      catalog.listCollectionsForItem
        ? catalog.listCollectionsForItem(itemKey).catch(() => [])
        : Promise.resolve([]),
    ]);
    if (!mountedRef.current) return;
    setCollections(cols);
    setMemberIds(new Set(existingIds));
  }, [catalog, itemKey]);

  useEffect(() => {
    if (!visible) return;
    setDraftName('');
    setStatusMessage(null);
    setFocusedRow(1);
    setFocusedCol(0);
    imeGuardRef.current.reset();
    void loadState();
  }, [loadState, visible]);

  useEffect(() => {
    if (!visible || (Platform.OS as string) !== 'web') return undefined;
    type WebKeyEvt = {
      key?: string;
      isComposing?: boolean;
      keyCode?: number;
      preventDefault?: () => void;
    };
    const host = globalThis as unknown as {
      addEventListener?: (type: string, fn: (e: WebKeyEvt) => void) => void;
      removeEventListener?: (type: string, fn: (e: WebKeyEvt) => void) => void;
    };
    const onKeyDown = (e: WebKeyEvt) => {
      if (e.key === 'Escape' && !isImeComposingEvent(e)) {
        e.preventDefault?.();
        onClose();
      }
    };
    host.addEventListener?.('keydown', onKeyDown);
    return () => host.removeEventListener?.('keydown', onKeyDown);
  }, [onClose, visible]);

  const focusRows = useMemo(() => buildCollectionPickerFocusRows(collections), [collections]);

  useEffect(() => {
    setFocusedRow((prev) => {
      const clamped = Math.min(prev, Math.max(0, focusRows.length - 1));
      const maxCol = Math.max(0, (focusRows[clamped]?.cols.length ?? 1) - 1);
      setFocusedCol((col) => Math.min(col, maxCol));
      return clamped;
    });
  }, [focusRows]);

  const handleToggleMembership = useCallback(
    async (collectionId: string) => {
      if (busy) return;
      const wasMember = memberIds.has(collectionId);
      const nextSet = toggleMembershipSet(memberIds, collectionId);
      const prevCols = collections;
      setMemberIds(nextSet);
      setCollections(applyCollectionMembershipDelta(prevCols, collectionId, !wasMember));
      setBusy(true);
      try {
        const res = wasMember
          ? await catalog.removeItemFromCollection?.(collectionId, itemKey)
          : await catalog.addItemToCollection?.(collectionId, itemKey, itemKind);
        if (!mountedRef.current) return;
        if (res && !res.ok) {
          setMemberIds(memberIds);
          setCollections(prevCols);
          return;
        }
        setStatusMessage(i18n.t('collections.saved'));
        onMutated?.(Array.from(nextSet));
      } catch {
        if (!mountedRef.current) return;
        setMemberIds(memberIds);
        setCollections(prevCols);
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, catalog, collections, i18n, itemKey, itemKind, memberIds, onMutated],
  );

  const handleCreateAndAdd = useCallback(async () => {
    const validName = validateCollectionNameDraft(draftName);
    if (validName === null || busy || !catalog.createCollection) return;
    setBusy(true);
    try {
      const created = await catalog.createCollection({ name: validName });
      if (!mountedRef.current || !created.ok) return;
      if (catalog.addItemToCollection) {
        await catalog.addItemToCollection(created.value.id, itemKey, itemKind);
      }
      if (!mountedRef.current) return;
      const nextSet = new Set(memberIds);
      nextSet.add(created.value.id);
      setDraftName('');
      setMemberIds(nextSet);
      setCollections((prev) => [...prev, { ...created.value, itemCount: 1 }]);
      setStatusMessage(i18n.t('collections.saved'));
      onMutated?.(Array.from(nextSet));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, catalog, draftName, i18n, itemKey, itemKind, memberIds, onMutated]);

  const handleSubmitDraft = useCallback(
    (event?: unknown) => {
      if (!imeGuardRef.current.shouldAllowSubmit(event)) return;
      void handleCreateAndAdd();
    },
    [handleCreateAndAdd],
  );

  const navRef = useRef({
    focusRows,
    focusedRow,
    focusedCol,
    onClose,
    handleToggleMembership,
    handleCreateAndAdd,
  });
  navRef.current = {
    focusRows,
    focusedRow,
    focusedCol,
    onClose,
    handleToggleMembership,
    handleCreateAndAdd,
  };

  const handleTvNavigate = useCallback((key: KeyInput['key']) => {
    const s = navRef.current;
    const row = s.focusRows[s.focusedRow];
    if (!row) return;
    if (key === 'up') {
      const next = Math.max(0, s.focusedRow - 1);
      const maxCol = Math.max(0, (s.focusRows[next]?.cols.length ?? 1) - 1);
      setFocusedRow(next);
      setFocusedCol((c) => Math.min(c, maxCol));
      return;
    }
    if (key === 'down') {
      const next = Math.min(s.focusRows.length - 1, s.focusedRow + 1);
      const maxCol = Math.max(0, (s.focusRows[next]?.cols.length ?? 1) - 1);
      setFocusedRow(next);
      setFocusedCol((c) => Math.min(c, maxCol));
      return;
    }
    if (key === 'left') {
      setFocusedCol((c) => Math.max(0, c - 1));
      return;
    }
    if (key === 'right') {
      setFocusedCol((c) => Math.min(row.cols.length - 1, c + 1));
      return;
    }
    if (key === 'select') {
      if (row.kind === 'close') s.onClose();
      else if (row.kind === 'collection') void s.handleToggleMembership(row.collectionId);
      else if (row.kind === 'create') {
        if (s.focusedCol === 0) inputRef.current?.focus();
        else void s.handleCreateAndAdd();
      }
    }
  }, []);

  if (!visible) return null;

  const activeRow = isTv ? (focusRows[focusedRow] ?? null) : null;
  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');
  const validDraft = validateCollectionNameDraft(draftName) !== null;

  return (
    <View testID="collection-picker-overlay" style={styles.root}>
      {isTv ? <PickerTvKeyTrap onBack={onClose} onNavigate={handleTvNavigate} /> : null}
      <Pressable
        testID="collection-picker-backdrop"
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={i18n.t('ui.dismiss')}
        onPress={onClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlayBackdrop }]}
      />
      <View
        testID="collection-picker-sheet"
        style={[
          styles.sheet,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={[styles.header, { borderBottomColor: theme.colors.surfaceBorder }]}>
          <View style={styles.headerTitles}>
            <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
              {i18n.t('collections.addToCollection')}
            </Text>
            <Text
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {itemTitle}
            </Text>
          </View>
          <CtaButton
            testID="collection-picker-close"
            label={i18n.t('collections.close')}
            variant="secondary"
            focusable={!isTv}
            focused={activeRow?.kind === 'close'}
            onPress={onClose}
          />
        </View>

        {statusMessage !== null ? (
          <View testID="collection-picker-status" style={styles.statusRow}>
            <MicroPill label={statusMessage} tone="success" />
          </View>
        ) : null}

        <ScrollView
          testID="collection-picker-list"
          style={styles.list}
          contentContainerStyle={styles.listContent}
          {...(isTv ? { focusable: false } : {})}
        >
          {collections.length === 0 ? (
            <Text
              testID="collection-picker-empty"
              style={[theme.typography.body, { color: theme.colors.textMuted }]}
            >
              {i18n.t('collections.empty')}
            </Text>
          ) : (
            collections.map((col) => {
              const selected = memberIds.has(col.id);
              const rowFocused =
                activeRow?.kind === 'collection' && activeRow.collectionId === col.id;
              return (
                <Pressable
                  key={col.id}
                  testID={`collection-picker-row-${col.id}`}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={col.name}
                  focusable={!isTv}
                  onPress={() => void handleToggleMembership(col.id)}
                  style={({ pressed }) => [
                    styles.row,
                    cursor,
                    transition,
                    {
                      borderRadius: theme.radius.card,
                      backgroundColor: rowFocused
                        ? theme.colors.focusFill
                        : selected
                          ? theme.colors.subtleHighlight
                          : theme.colors.bgSurface,
                      borderWidth: rowFocused ? theme.focus.ringWidth : 1,
                      borderColor: rowFocused
                        ? theme.colors.focusRingColor
                        : selected
                          ? theme.colors.accent
                          : theme.colors.surfaceBorder,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <View
                    testID={`collection-picker-check-${col.id}`}
                    style={[
                      styles.checkbox,
                      {
                        borderRadius: theme.radius.button,
                        borderColor: selected ? theme.colors.accent : theme.colors.surfaceBorder,
                        backgroundColor: selected ? theme.colors.accent : 'transparent',
                      },
                    ]}
                  >
                    {selected ? (
                      <Icon name="check" size={14} color={theme.colors.accentContrast} />
                    ) : null}
                  </View>
                  <Text
                    numberOfLines={1}
                    style={[
                      theme.typography.title,
                      styles.flex1,
                      { color: theme.colors.textPrimary },
                    ]}
                  >
                    {col.name}
                  </Text>
                  <Text
                    style={[
                      theme.typography.caption,
                      TABULAR_NUMS_STYLE,
                      { color: theme.colors.textSecondary },
                    ]}
                  >
                    {i18n.t('collections.itemCount', { count: col.itemCount })}
                  </Text>
                </Pressable>
              );
            })
          )}
        </ScrollView>

        <View style={[styles.createRow, { borderTopColor: theme.colors.surfaceBorder }]}>
          <TvTextInput
            ref={inputRef}
            testID="collection-picker-new-input"
            value={draftName}
            onChangeText={setDraftName}
            placeholder={i18n.t('collections.createPlaceholder')}
            placeholderTextColor={theme.colors.textMuted}
            onKeyPress={(e) => imeGuardRef.current.onKeyPress(e)}
            onSubmitEditing={handleSubmitDraft}
            style={[
              styles.input,
              theme.typography.body,
              {
                color: theme.colors.textPrimary,
                backgroundColor:
                  activeRow?.kind === 'create' && focusedCol === 0
                    ? theme.colors.focusFill
                    : theme.colors.bgCard,
                borderWidth:
                  activeRow?.kind === 'create' && focusedCol === 0 ? theme.focus.ringWidth : 1,
                borderColor:
                  activeRow?.kind === 'create' && focusedCol === 0
                    ? theme.colors.focusRingColor
                    : theme.colors.surfaceBorder,
                borderRadius: theme.radius.button,
              },
            ]}
          />
          <CtaButton
            testID="collection-picker-create-btn"
            label={i18n.t('collections.createAction')}
            variant="primary"
            disabled={busy || !validDraft}
            focusable={!isTv}
            focused={activeRow?.kind === 'create' && focusedCol === 1}
            onPress={() => void handleCreateAndAdd()}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * In-tree Cinema Quietude v2 overlay for assigning a movie or series to custom VOD collections (`#403`).
 * Never uses React Native `<Modal>`; supports full 2D TV D-pad navigation, IME-safe inline creation,
 * and clean Back/Escape dismissal.
 */
export function CollectionPickerOverlay(props: CollectionPickerOverlayProps): ReactElement | null {
  if (!props.visible) return null;
  return (
    <TextEntryBoundary>
      <CollectionPickerOverlayBody {...props} />
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
  sheet: {
    width: '100%',
    maxWidth: 540,
    maxHeight: '84%',
    borderWidth: 1,
    overflow: 'hidden',
  },
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
  statusRow: { paddingHorizontal: 20, paddingTop: 10 },
  list: { maxHeight: 340 },
  listContent: { padding: 20, gap: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 46,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex1: { flex: 1, minWidth: 0 },
  createRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minWidth: 140,
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});
