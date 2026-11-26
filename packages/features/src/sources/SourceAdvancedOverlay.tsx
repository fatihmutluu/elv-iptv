import type { SourceRow } from '@elv/data';
import type { KeyInput } from '@elv/focus-core';
import type { AppI18n } from '@elv/i18n';
import {
  Icon,
  IconButton,
  MicroPill,
  TvFocusAnchor,
  type TvTextInputInstance,
  useTheme,
  useTvKeyInterceptor,
  useTvKeySource,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useProfile } from '../shared';
import { type NetworkFieldSharedProps, SourceNetworkEditor } from './SourceNetworkEditor';
import { ActionButton, FieldInput } from './SourcesScreenParts';
import type { SourceNetworkEditorState } from './useSourceNetworkEditor';
import type { SourcesController } from './useSourcesController';

const NOOP_TV_SUBSCRIBER = (): boolean => false;
const MAX_SOURCE_NAME_LEN = 80;

type AdvancedView = 'menu' | 'rename' | 'profiles' | 'network';

interface MenuEntry {
  readonly id: string;
  readonly testID: string;
  readonly label: string;
  readonly subtitle?: string;
  readonly run: () => void;
}

/** Props of {@link SourceAdvancedOverlay}. */
export interface SourceAdvancedOverlayProps {
  readonly source: SourceRow | null;
  readonly ctrl: SourcesController;
  readonly networkEditor: SourceNetworkEditorState;
  readonly i18n: AppI18n;
  readonly onOpenGuides?: (source: SourceRow) => void;
  readonly onClose: () => void;
}

function AdvancedTvKeyTrap({ onKey }: { readonly onKey: (input: KeyInput) => void }): ReactElement {
  const ref = useRef(onKey);
  ref.current = onKey;
  useTvKeySource(NOOP_TV_SUBSCRIBER);
  useTvKeyInterceptor((input: KeyInput) => {
    if (input.action !== 'down' && input.action !== 'press') return true;
    ref.current(input);
    return true;
  });
  return <TvFocusAnchor testID="source-advanced-tv-focus-anchor" hasTVPreferredFocus />;
}

/**
 * Cinema Quietude v2 in-tree modal for per-source advanced settings:
 * Rename, Shared with profiles, Choose categories, Refresh guide, Guides & mapping, and Network.
 */
export function SourceAdvancedOverlay({
  source,
  ctrl,
  networkEditor,
  i18n,
  onOpenGuides,
  onClose,
}: SourceAdvancedOverlayProps): ReactElement | null {
  const theme = useTheme();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';
  const { profiles } = useProfile();

  const [view, setView] = useState<AdvancedView>('menu');
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [editingInputId, setEditingInputId] = useState<string | null>(null);

  const inputRefs = useRef<Map<string, TvTextInputInstance>>(new Map());
  const registerRef = useCallback((id: string, node: TvTextInputInstance | null) => {
    if (node === null) inputRefs.current.delete(id);
    else inputRefs.current.set(id, node);
  }, []);
  const handleEndEditing = useCallback((focusId: string) => {
    setEditingInputId((cur) => (cur === focusId ? null : cur));
  }, []);

  const sourceId = source?.id ?? null;
  const sourceName = source?.name ?? '';

  // Reset sub-view whenever a different source opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset sub-view strictly when modal target changes
  useEffect(() => {
    setView('menu');
    setFocusedIndex(0);
    setEditingInputId(null);
    setRenameDraft(sourceName);
    setRenameError(null);
    setRenaming(false);
  }, [sourceId]);

  const handleClose = useCallback(() => {
    networkEditor.close();
    setEditingInputId(null);
    setView('menu');
    onClose();
  }, [networkEditor, onClose]);

  const handleBackToMenu = useCallback(() => {
    if (view === 'network') networkEditor.close();
    setEditingInputId(null);
    setRenameError(null);
    setView('menu');
    setFocusedIndex(0);
  }, [networkEditor, view]);

  useEffect(() => {
    if (source === null || (Platform.OS as string) !== 'web') return undefined;
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
    };
    const onKeyDown = (e: { key?: string; preventDefault?: () => void }) => {
      if (e.key === 'Escape') {
        e.preventDefault?.();
        if (view !== 'menu') handleBackToMenu();
        else handleClose();
      }
    };
    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [handleBackToMenu, handleClose, source, view]);

  const handleSaveRename = useCallback(async () => {
    if (source === null || renaming) return;
    const trimmed = renameDraft.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_SOURCE_NAME_LEN) return;
    setRenaming(true);
    setRenameError(null);
    try {
      const res = await ctrl.renameSource(source.id, trimmed);
      if (res.ok) {
        setView('menu');
        setFocusedIndex(0);
      } else {
        setRenameError(i18n.t('source.error.storage'));
      }
    } finally {
      setRenaming(false);
    }
  }, [ctrl, i18n, renameDraft, renaming, source]);

  const handleToggleProfile = useCallback(
    (profileId: string) => {
      if (source === null) return;
      const currentExcluded = source.excludedProfileIds ?? [];
      const isExcluded = currentExcluded.includes(profileId);
      const nextExcluded = isExcluded
        ? currentExcluded.filter((id) => id !== profileId)
        : [...currentExcluded, profileId];
      void ctrl.setSourceExcludedProfiles(source.id, nextExcluded);
    },
    [ctrl, source],
  );

  const menuEntries = useMemo<readonly MenuEntry[]>(() => {
    if (source === null) return [];
    const excludedCount = source.excludedProfileIds?.length ?? 0;
    const sharedCount = Math.max(0, profiles.length - excludedCount);
    const profilesSummary =
      excludedCount === 0
        ? i18n.t('sources.advanced.allProfilesShared')
        : `${sharedCount} / ${profiles.length}`;
    const list: MenuEntry[] = [];
    if (ctrl.canRenameSource) {
      list.push({
        id: 'rename',
        testID: `source-advanced-rename-${source.id}`,
        label: i18n.t('sources.advanced.rename'),
        subtitle: source.name,
        run: () => {
          setRenameDraft(source.name);
          setRenameError(null);
          setView('rename');
          setFocusedIndex(0);
        },
      });
    }
    if (ctrl.canShareProfiles) {
      list.push({
        id: 'profiles',
        testID: `source-advanced-profiles-${source.id}`,
        label: i18n.t('sources.advanced.sharedProfiles'),
        subtitle: profilesSummary,
        run: () => {
          setView('profiles');
          setFocusedIndex(0);
        },
      });
    }
    if (ctrl.canChooseCategories) {
      list.push({
        id: 'categories',
        testID: `source-categories-${source.id}`,
        label: i18n.t('sources.chooseCategories'),
        run: () => {
          handleClose();
          void ctrl.openCategoryPicker(source);
        },
      });
    }
    if (!source.needsImport && ctrl.canRefreshGuide) {
      list.push({
        id: 'refresh-guide',
        testID: `source-refresh-guide-${source.id}`,
        label: i18n.t('sources.refreshGuide'),
        run: () => {
          handleClose();
          void ctrl.runGuideRefresh(source.id);
        },
      });
    }
    if (onOpenGuides !== undefined) {
      list.push({
        id: 'guides',
        testID: `source-guides-${source.id}`,
        label: i18n.t('sources.guides.button'),
        run: () => {
          handleClose();
          onOpenGuides(source);
        },
      });
    }
    if (ctrl.canEditNetwork) {
      list.push({
        id: 'network',
        testID: `source-network-${source.id}`,
        label: i18n.t('sources.network.title'),
        run: () => {
          networkEditor.openSource(source);
          setView('network');
          setFocusedIndex(0);
        },
      });
    }
    return list;
  }, [ctrl, handleClose, i18n, networkEditor, onOpenGuides, profiles.length, source]);

  const networkFocusIds = useMemo(
    () =>
      source === null
        ? []
        : [
            `source-network-dns-system-${source.id}`,
            `source-network-dns-ipv4-${source.id}`,
            `source-network-dns-ipv6-${source.id}`,
            `source-network-host-${source.id}`,
            `source-network-save-${source.id}`,
          ],
    [source],
  );

  const handleTvKey = useCallback(
    (input: KeyInput) => {
      if (source === null) return;
      if (input.key === 'back') {
        if (editingInputId !== null) {
          inputRefs.current.get(editingInputId)?.blur();
          setEditingInputId(null);
          return;
        }
        if (view !== 'menu') {
          handleBackToMenu();
        } else {
          handleClose();
        }
        return;
      }
      if (view === 'menu') {
        const count = menuEntries.length;
        if (count === 0) return;
        if (input.key === 'down') setFocusedIndex((i) => Math.min(count - 1, i + 1));
        else if (input.key === 'up') setFocusedIndex((i) => Math.max(0, i - 1));
        else if (input.key === 'select') menuEntries[focusedIndex]?.run();
        return;
      }
      if (view === 'rename') {
        if (input.key === 'down') setFocusedIndex(1);
        else if (input.key === 'up') setFocusedIndex(0);
        else if (input.key === 'select') {
          if (focusedIndex === 0) {
            setEditingInputId('source-rename-input');
            inputRefs.current.get('source-rename-input')?.focus();
          } else {
            void handleSaveRename();
          }
        }
        return;
      }
      if (view === 'profiles') {
        const count = profiles.length;
        if (count === 0) return;
        if (input.key === 'down') setFocusedIndex((i) => Math.min(count - 1, i + 1));
        else if (input.key === 'up') setFocusedIndex((i) => Math.max(0, i - 1));
        else if (input.key === 'select') {
          const target = profiles[focusedIndex];
          if (target !== undefined) handleToggleProfile(target.id);
        }
        return;
      }
      // view === 'network': indices 0..2 DNS, 3 host input, 4 save
      const maxIdx = networkFocusIds.length - 1;
      if (input.key === 'right' && focusedIndex < 2) {
        setFocusedIndex((i) => i + 1);
      } else if (input.key === 'left' && focusedIndex > 0 && focusedIndex <= 2) {
        setFocusedIndex((i) => i - 1);
      } else if (input.key === 'down') {
        setFocusedIndex((i) => (i <= 2 ? 3 : Math.min(maxIdx, i + 1)));
      } else if (input.key === 'up') {
        setFocusedIndex((i) => (i === 3 ? 0 : Math.max(0, i - 1)));
      } else if (input.key === 'select') {
        if (focusedIndex === 0) networkEditor.setDnsFamily('system');
        else if (focusedIndex === 1) networkEditor.setDnsFamily('ipv4');
        else if (focusedIndex === 2) networkEditor.setDnsFamily('ipv6');
        else if (focusedIndex === 3) {
          const hostId = `source-network-host-${source.id}`;
          setEditingInputId(hostId);
          inputRefs.current.get(hostId)?.focus();
        } else if (focusedIndex === 4) {
          void networkEditor.save(source);
        }
      }
    },
    [
      editingInputId,
      focusedIndex,
      handleBackToMenu,
      handleClose,
      handleSaveRename,
      handleToggleProfile,
      menuEntries,
      networkEditor,
      networkFocusIds.length,
      profiles,
      source,
      view,
    ],
  );

  if (source === null) return null;

  const networkFieldShared: NetworkFieldSharedProps = {
    editingInputId,
    onEndEditing: handleEndEditing,
    registerRef,
  };
  const tvNetworkFocusId = isTv && view === 'network' ? networkFocusIds[focusedIndex] : undefined;
  const headerTitle =
    view === 'rename'
      ? i18n.t('sources.advanced.rename')
      : view === 'profiles'
        ? i18n.t('sources.advanced.sharedProfiles')
        : view === 'network'
          ? i18n.t('sources.network.title')
          : i18n.t('sources.advanced.title');
  const trimmedRename = renameDraft.trim();
  const canSaveRename =
    !renaming && trimmedRename.length > 0 && trimmedRename.length <= MAX_SOURCE_NAME_LEN;
  const excludedSet = new Set(source.excludedProfileIds ?? []);

  return (
    <View testID={`source-advanced-overlay-${source.id}`} style={styles.root}>
      {isTv ? <AdvancedTvKeyTrap onKey={handleTvKey} /> : null}
      <Pressable
        testID="source-advanced-backdrop"
        focusable={false}
        accessibilityRole="button"
        accessibilityLabel={i18n.t('sources.qr.close')}
        onPress={handleClose}
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.overlayBackdrop }]}
      />
      <View
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
          {view !== 'menu' ? (
            <IconButton
              testID="source-advanced-back"
              icon="back"
              size={34}
              accessibilityLabel={i18n.t('player.settingsBack')}
              focusable={!isTv}
              onPress={handleBackToMenu}
            />
          ) : null}
          <View style={styles.headerTitles}>
            <Text
              numberOfLines={1}
              style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
            >
              {headerTitle}
            </Text>
            <Text
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {source.name}
            </Text>
          </View>
          <IconButton
            testID="source-advanced-close"
            icon="close"
            size={34}
            accessibilityLabel={i18n.t('sources.qr.close')}
            focusable={!isTv}
            onPress={handleClose}
          />
        </View>

        <ScrollView focusable={!isTv} contentContainerStyle={styles.body}>
          {view === 'menu' ? (
            menuEntries.map((entry, idx) => {
              const focused = isTv && focusedIndex === idx;
              return (
                <Pressable
                  key={entry.id}
                  testID={entry.testID}
                  {...(isTv ? { focusable: false } : {})}
                  accessibilityRole="button"
                  accessibilityLabel={entry.label}
                  onPress={entry.run}
                  style={({ pressed }) => [
                    styles.menuRow,
                    {
                      backgroundColor: focused
                        ? theme.colors.focusFill
                        : pressed
                          ? theme.colors.actionGlassHoverBg
                          : theme.colors.bgCard,
                      borderColor: focused
                        ? theme.colors.focusRingColor
                        : theme.colors.surfaceBorder,
                      borderWidth: focused ? theme.focus.ringWidth : 1,
                      borderRadius: theme.radius.card,
                    },
                    webCursorPointer(),
                  ]}
                >
                  <View style={styles.menuRowText}>
                    <Text
                      numberOfLines={1}
                      style={[theme.typography.title, { color: theme.colors.textPrimary }]}
                    >
                      {entry.label}
                    </Text>
                    {entry.subtitle !== undefined ? (
                      <Text
                        numberOfLines={1}
                        style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                      >
                        {entry.subtitle}
                      </Text>
                    ) : null}
                  </View>
                  <Icon name="chevronRight" size={16} color={theme.colors.textMuted} />
                </Pressable>
              );
            })
          ) : view === 'rename' ? (
            <View testID="source-advanced-rename-view" style={styles.subView}>
              <FieldInput
                focusId="source-rename-input"
                testID="source-rename-input"
                label={i18n.t('sources.advanced.rename')}
                placeholder={i18n.t('sources.advanced.renamePlaceholder')}
                value={renameDraft}
                onChangeText={(v) => {
                  setRenameDraft(v);
                  setRenameError(null);
                }}
                tvFocused={isTv && focusedIndex === 0}
                editingInputId={editingInputId}
                onEndEditing={handleEndEditing}
                onSubmit={() => void handleSaveRename()}
                registerRef={registerRef}
              />
              {renameError !== null ? (
                <Text
                  testID="source-rename-error"
                  style={[theme.typography.caption, { color: theme.colors.liveColor }]}
                >
                  {renameError}
                </Text>
              ) : null}
              <View style={styles.footerActions}>
                <ActionButton
                  focusId="source-rename-save"
                  testID="source-rename-save"
                  label={i18n.t('sources.advanced.renameSave')}
                  primary
                  disabled={!canSaveRename}
                  tvFocused={isTv && focusedIndex === 1}
                  onPress={() => void handleSaveRename()}
                />
              </View>
            </View>
          ) : view === 'profiles' ? (
            <View testID="source-advanced-profiles-view" style={styles.subView}>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {i18n.t('sources.advanced.sharedProfilesHint')}
              </Text>
              {profiles.map((p, idx) => {
                const isShared = !excludedSet.has(p.id);
                const focused = isTv && focusedIndex === idx;
                return (
                  <Pressable
                    key={p.id}
                    testID={`source-profile-toggle-${p.id}`}
                    {...(isTv ? { focusable: false } : {})}
                    accessibilityRole="checkbox"
                    accessibilityLabel={p.name}
                    accessibilityState={{ checked: isShared }}
                    onPress={() => handleToggleProfile(p.id)}
                    style={({ pressed }) => [
                      styles.menuRow,
                      {
                        backgroundColor: focused
                          ? theme.colors.focusFill
                          : pressed
                            ? theme.colors.actionGlassHoverBg
                            : theme.colors.bgCard,
                        borderColor: focused
                          ? theme.colors.focusRingColor
                          : theme.colors.surfaceBorder,
                        borderWidth: focused ? theme.focus.ringWidth : 1,
                        borderRadius: theme.radius.card,
                      },
                      webCursorPointer(),
                    ]}
                  >
                    <View style={styles.profileRowLeft}>
                      <View
                        style={[
                          styles.checkbox,
                          {
                            borderRadius: theme.radius.button,
                            borderColor: isShared ? theme.colors.accent : theme.colors.chipBorder,
                            backgroundColor: isShared ? theme.colors.accent : 'transparent',
                          },
                        ]}
                      >
                        {isShared ? (
                          <Icon name="check" size={14} color={theme.colors.accentContrast} />
                        ) : null}
                      </View>
                      <Text
                        numberOfLines={1}
                        style={[theme.typography.title, { color: theme.colors.textPrimary }]}
                      >
                        {p.name}
                      </Text>
                      {p.isKids ? (
                        <MicroPill label={i18n.t('profiles.kidsBadge')} tone="accent" />
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <View testID="source-advanced-network-view" style={styles.subView}>
              <SourceNetworkEditor
                source={source}
                editor={networkEditor}
                tvFocusId={tvNetworkFocusId}
                fieldShared={networkFieldShared}
                i18n={i18n}
              />
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 56,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '85%',
    borderWidth: 1,
    padding: 20,
    gap: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitles: { flex: 1, gap: 2 },
  body: { gap: 10 },
  subView: { gap: 12 },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 48,
  },
  menuRowText: { flex: 1, gap: 2 },
  profileRowLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkbox: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
