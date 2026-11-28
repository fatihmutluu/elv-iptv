import {
  type ItemRow,
  type LiveFavoriteFolderRecord,
  MAX_LIVE_FAVORITE_FOLDER_NAME_LENGTH,
} from '@elv/data';
import {
  CtaButton,
  Icon,
  useI18n,
  useTheme,
  useTvKeyInterceptor,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useDesktopDialogTrap } from '../shared/desktop-dialog-trap';

/** Active modal mode for {@link LiveFavoriteFolderModal}. */
export type LiveFavoriteFolderModalMode =
  | { readonly kind: 'move'; readonly channel: ItemRow }
  | { readonly kind: 'create' }
  | { readonly kind: 'manage'; readonly folder: LiveFavoriteFolderRecord };

/** Props of {@link LiveFavoriteFolderModal}. */
export interface LiveFavoriteFolderModalProps {
  readonly mode: LiveFavoriteFolderModalMode | null;
  readonly folders: readonly LiveFavoriteFolderRecord[];
  readonly currentFolderId: string | null;
  readonly isTv: boolean;
  readonly onAssignFolder: (channel: ItemRow, folderId: string | null) => Promise<boolean>;
  readonly onCreateFolder: (name: string) => Promise<LiveFavoriteFolderRecord | null>;
  readonly onRenameFolder: (id: string, name: string) => Promise<boolean>;
  readonly onDeleteFolder: (id: string) => Promise<boolean>;
  readonly onClose: () => void;
}

function FolderModalTvKeyTrap({ onClose }: { readonly onClose: () => void }): null {
  useTvKeyInterceptor((input) => {
    if ((input.action === 'down' || input.action === 'press') && input.key === 'back') {
      onClose();
      return true;
    }
    return false;
  });
  return null;
}

/**
 * In-tree Cinema Quietude frosted overlay for assigning a live channel to a favorite folder,
 * creating a new folder, or renaming/deleting an existing folder (never uses raw RN `<Modal>`).
 */
export function LiveFavoriteFolderModal({
  mode,
  folders,
  currentFolderId,
  isTv,
  onAssignFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onClose,
}: LiveFavoriteFolderModalProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const dialogRef = useRef<ComponentRef<typeof View> | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionError, setActionError] = useState(false);

  useDesktopDialogTrap(dialogRef, mode !== null && !isTv, onClose);

  useEffect(() => {
    if (mode === null) return;
    setBusy(false);
    setConfirmDelete(false);
    setActionError(false);
    setNameInput(mode.kind === 'manage' ? mode.folder.name : '');
  }, [mode]);

  useEffect(() => {
    if (mode === null || (Platform.OS as string) !== 'web') return;
    const win = globalThis as {
      addEventListener?: (
        type: string,
        fn: (e: {
          key?: string;
          preventDefault?: () => void;
          stopPropagation?: () => void;
        }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        fn: (e: {
          key?: string;
          preventDefault?: () => void;
          stopPropagation?: () => void;
        }) => void,
      ) => void;
    };
    const onKeyDown = (e: {
      key?: string;
      preventDefault?: () => void;
      stopPropagation?: () => void;
    }) => {
      if (e.key === 'Escape') {
        e.preventDefault?.();
        e.stopPropagation?.();
        onClose();
      }
    };
    win.addEventListener?.('keydown', onKeyDown);
    return () => win.removeEventListener?.('keydown', onKeyDown);
  }, [mode, onClose]);

  const handleAssign = useCallback(
    async (folderId: string | null) => {
      if (mode?.kind !== 'move' || busy) return;
      setActionError(false);
      setBusy(true);
      try {
        const ok = await onAssignFolder(mode.channel, folderId);
        if (ok) onClose();
        else setActionError(true);
      } catch {
        setActionError(true);
      } finally {
        setBusy(false);
      }
    },
    [busy, mode, onAssignFolder, onClose],
  );

  const handleSubmit = useCallback(async () => {
    if (mode === null || busy) return;
    const trimmed = nameInput.trim();
    if (trimmed.length === 0) return;
    setActionError(false);
    setBusy(true);
    try {
      if (mode.kind === 'create') {
        const created = await onCreateFolder(trimmed);
        if (created !== null) onClose();
        else setActionError(true);
      } else if (mode.kind === 'move') {
        const created = await onCreateFolder(trimmed);
        if (created !== null) {
          const assigned = await onAssignFolder(mode.channel, created.id);
          if (assigned) onClose();
          else setActionError(true);
        } else {
          setActionError(true);
        }
      } else if (mode.kind === 'manage') {
        const ok = await onRenameFolder(mode.folder.id, trimmed);
        if (ok) onClose();
        else setActionError(true);
      }
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  }, [busy, mode, nameInput, onAssignFolder, onClose, onCreateFolder, onRenameFolder]);

  const handleDelete = useCallback(async () => {
    if (mode?.kind !== 'manage' || busy) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setActionError(false);
    setBusy(true);
    try {
      const ok = await onDeleteFolder(mode.folder.id);
      if (ok) onClose();
      else setActionError(true);
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  }, [busy, confirmDelete, mode, onClose, onDeleteFolder]);

  if (mode === null) return null;

  const cursor = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, opacity');
  const title =
    mode.kind === 'move'
      ? i18n.t('live.folders.moveModalTitle')
      : mode.kind === 'create'
        ? i18n.t('live.folders.createTitle')
        : i18n.t('live.folders.renameTitle');
  const submitLabel =
    mode.kind === 'move'
      ? i18n.t('live.folders.createAndMove')
      : mode.kind === 'create'
        ? i18n.t('live.folders.createFolder')
        : i18n.t('live.folders.save');
  const canSubmit = nameInput.trim().length > 0 && !busy;
  const webBackdropProps = Platform.OS === 'web' ? ({ tabIndex: -1 } as object) : {};

  return (
    <View ref={dialogRef} testID="live-favorite-folder-modal" style={styles.root}>
      {isTv ? <FolderModalTvKeyTrap onClose={onClose} /> : null}
      <Pressable
        testID="live-folder-modal-backdrop"
        focusable={false}
        {...webBackdropProps}
        accessibilityRole="button"
        accessibilityLabel={i18n.t('ui.dismiss')}
        onPress={onClose}
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
          <Text
            numberOfLines={1}
            style={[theme.typography.title, { color: theme.colors.textPrimary }]}
          >
            {title}
          </Text>
          {mode.kind === 'move' ? (
            <Text
              numberOfLines={1}
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {mode.channel.name}
            </Text>
          ) : null}
        </View>

        {mode.kind === 'move' ? (
          <ScrollView style={styles.optionScroll} contentContainerStyle={styles.optionList}>
            <Pressable
              testID="live-folder-modal-option-unfiled"
              accessibilityRole="button"
              accessibilityLabel={i18n.t('live.folders.unfiled')}
              disabled={busy}
              onPress={() => void handleAssign(null)}
              style={({ pressed }) => [
                styles.optionRow,
                {
                  borderRadius: theme.radius.button,
                  backgroundColor:
                    currentFolderId === null
                      ? theme.colors.focusFill
                      : pressed
                        ? theme.colors.subtleHighlight
                        : 'transparent',
                },
                cursor,
                transition,
              ]}
            >
              <Text
                numberOfLines={1}
                style={[theme.typography.body, styles.flex1, { color: theme.colors.textPrimary }]}
              >
                {i18n.t('live.folders.unfiled')}
              </Text>
              {currentFolderId === null ? (
                <Icon name="check" size={16} color={theme.colors.accent} />
              ) : null}
            </Pressable>

            {folders.map((folder) => {
              const selected = currentFolderId === folder.id;
              return (
                <Pressable
                  key={folder.id}
                  testID={`live-folder-modal-option-${folder.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={folder.name}
                  disabled={busy}
                  onPress={() => void handleAssign(folder.id)}
                  style={({ pressed }) => [
                    styles.optionRow,
                    {
                      borderRadius: theme.radius.button,
                      backgroundColor: selected
                        ? theme.colors.focusFill
                        : pressed
                          ? theme.colors.subtleHighlight
                          : 'transparent',
                    },
                    cursor,
                    transition,
                  ]}
                >
                  <Text
                    numberOfLines={1}
                    style={[
                      theme.typography.body,
                      styles.flex1,
                      { color: theme.colors.textPrimary },
                    ]}
                  >
                    {folder.name}
                  </Text>
                  {selected ? <Icon name="check" size={16} color={theme.colors.accent} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        <View
          style={[
            styles.inputSection,
            mode.kind === 'move'
              ? {
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderTopColor: theme.colors.surfaceBorder,
                  paddingTop: 12,
                }
              : null,
          ]}
        >
          <TextInput
            testID="live-folder-modal-name-input"
            value={nameInput}
            onChangeText={setNameInput}
            placeholder={i18n.t('live.folders.namePlaceholder')}
            placeholderTextColor={theme.colors.textMuted}
            maxLength={MAX_LIVE_FAVORITE_FOLDER_NAME_LENGTH}
            autoFocus={!isTv && mode.kind !== 'move'}
            returnKeyType="done"
            onSubmitEditing={() => void handleSubmit()}
            style={[
              theme.typography.body,
              styles.input,
              {
                color: theme.colors.textPrimary,
                backgroundColor: theme.colors.bgSurface,
                borderColor: theme.colors.surfaceBorder,
                borderRadius: theme.radius.button,
              },
            ]}
          />

          {mode.kind === 'manage' && confirmDelete ? (
            <Text
              testID="live-folder-modal-delete-warning"
              style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
            >
              {i18n.t('live.folders.deleteBody', { name: mode.folder.name })}
            </Text>
          ) : null}

          {actionError ? (
            <Text
              testID="live-folder-modal-error"
              style={[theme.typography.caption, { color: theme.colors.dangerBorder }]}
            >
              {i18n.t('source.error.storage')}
            </Text>
          ) : null}

          <View style={styles.footer}>
            {mode.kind === 'manage' ? (
              <CtaButton
                testID="live-folder-modal-delete"
                variant="secondary"
                label={i18n.t(confirmDelete ? 'live.folders.deleteTitle' : 'live.folders.delete')}
                disabled={busy}
                onPress={() => void handleDelete()}
              />
            ) : null}
            <View style={styles.footerRight}>
              <CtaButton
                testID="live-folder-modal-cancel"
                variant="secondary"
                label={i18n.t('live.folders.cancel')}
                disabled={busy}
                onPress={onClose}
              />
              <CtaButton
                testID="live-folder-modal-submit"
                variant="primary"
                label={submitLabel}
                disabled={!canSubmit}
                onPress={() => void handleSubmit()}
              />
            </View>
          </View>
        </View>
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
    zIndex: 50,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 400,
    borderWidth: 1,
    padding: 18,
    gap: 12,
  },
  header: {
    gap: 2,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionScroll: { maxHeight: 220 },
  optionList: { gap: 4 },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 42,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  inputSection: { gap: 10 },
  input: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 42,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
  },
  footerRight: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
  flex1: { flex: 1 },
});
