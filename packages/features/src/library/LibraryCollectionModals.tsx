import type { KeyEvent } from '@elv/focus-core';
import {
  CtaButton,
  TvFocusAnchor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  webBackdropBlur,
  webCursorPointer,
} from '@elv/ui-kit';
import {
  type ComponentRef,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { validateCollectionNameDraft } from '../shared/collections-model';

type ModalFocusSlot = 'input' | 'cancel' | 'confirm';

/** Active in-tree modal state for creating, renaming, or deleting a Library folder collection. */
export type LibraryCollectionModalState =
  | { readonly mode: 'create' }
  | { readonly mode: 'rename'; readonly collectionId: string; readonly currentName: string }
  | { readonly mode: 'delete'; readonly collectionId: string; readonly name: string };

/** Props of {@link LibraryCollectionModals}. */
export interface LibraryCollectionModalsProps {
  readonly modal: LibraryCollectionModalState | null;
  readonly isTv: boolean;
  readonly onClose: () => void;
  readonly onCreate: (name: string) => Promise<boolean>;
  readonly onRename: (collectionId: string, name: string) => Promise<boolean>;
  readonly onDelete: (collectionId: string) => Promise<boolean>;
}

function ModalTvKeyBridge({
  onEvent,
}: {
  readonly onEvent: (event: KeyEvent) => boolean;
}): ReactElement {
  useKeyInterpreter(onEvent);
  return <TvFocusAnchor testID="library-collection-modal-tv-anchor" hasTVPreferredFocus />;
}

/**
 * In-tree Cinema Quietude overlays for Create, Rename, and Delete Collection inside
 * `Library -> Following` (zero React Native `<Modal>`, 10-ft TV D-pad & Back safe).
 */
export function LibraryCollectionModals({
  modal,
  isTv,
  onClose,
  onCreate,
  onRename,
  onDelete,
}: LibraryCollectionModalsProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const [draftName, setDraftName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [focusedSlot, setFocusedSlot] = useState<ModalFocusSlot>('input');
  const inputRef = useRef<ComponentRef<typeof TextInput> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (modal === null) {
      setDraftName('');
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    setFocusedSlot(modal.mode === 'delete' ? 'confirm' : 'input');
    if (modal.mode === 'rename') {
      setDraftName(modal.currentName);
    } else if (modal.mode === 'create') {
      setDraftName('');
    }
  }, [modal]);

  useEffect(() => {
    if (modal === null || Platform.OS !== 'web') return undefined;
    const win = globalThis as unknown as {
      addEventListener?: (
        t: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
      removeEventListener?: (
        t: string,
        fn: (e: { key?: string; preventDefault?: () => void }) => void,
      ) => void;
    };
    if (!win.addEventListener || !win.removeEventListener) return undefined;
    const handleKeyDown = (event: { key?: string; preventDefault?: () => void }) => {
      if (event.key === 'Escape') {
        event.preventDefault?.();
        onClose();
      }
    };
    win.addEventListener('keydown', handleKeyDown);
    return () => {
      win.removeEventListener?.('keydown', handleKeyDown);
    };
  }, [modal, onClose]);

  const validDraft =
    modal !== null && modal.mode !== 'delete' ? validateCollectionNameDraft(draftName) : null;

  const handleConfirm = useCallback(async () => {
    if (modal === null || submitting) return;
    if (modal.mode === 'delete') {
      setSubmitting(true);
      try {
        const ok = await onDelete(modal.collectionId);
        if (ok) onClose();
      } finally {
        if (mountedRef.current) setSubmitting(false);
      }
      return;
    }
    const valid = validateCollectionNameDraft(draftName);
    if (valid === null) return;
    setSubmitting(true);
    try {
      const ok =
        modal.mode === 'create' ? await onCreate(valid) : await onRename(modal.collectionId, valid);
      if (ok) onClose();
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [draftName, modal, onClose, onCreate, onDelete, onRename, submitting]);

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind === 'press' && event.key === 'back') {
        onClose();
        return true;
      }
      if (event.kind !== 'press' && event.kind !== 'repeat') return false;
      const isDeleteMode = modal?.mode === 'delete';
      if (focusedSlot === 'input' && !isDeleteMode) {
        if (event.key === 'down') {
          setFocusedSlot('confirm');
          return true;
        }
        if (event.key === 'select') {
          inputRef.current?.focus();
          return true;
        }
        if (event.key === 'up' || event.key === 'left' || event.key === 'right') {
          return true;
        }
        return false;
      }
      if (event.key === 'up' && !isDeleteMode) {
        setFocusedSlot('input');
        return true;
      }
      if (event.key === 'left') {
        setFocusedSlot('cancel');
        return true;
      }
      if (event.key === 'right') {
        setFocusedSlot('confirm');
        return true;
      }
      if (event.key === 'select') {
        if (focusedSlot === 'cancel') onClose();
        else void handleConfirm();
        return true;
      }
      return false;
    },
    [focusedSlot, handleConfirm, modal?.mode, onClose],
  );

  if (modal === null) return null;

  const isDelete = modal.mode === 'delete';
  const title =
    modal.mode === 'create'
      ? i18n.t('library.collections.createTitle')
      : modal.mode === 'rename'
        ? i18n.t('library.collections.renameTitle')
        : i18n.t('library.collections.deleteConfirmTitle');
  const confirmLabel =
    modal.mode === 'create'
      ? i18n.t('collections.createAction')
      : modal.mode === 'rename'
        ? i18n.t('collections.save')
        : i18n.t('library.collections.delete');

  return (
    <View
      testID={isDelete ? 'library-collection-delete-modal' : 'library-collection-modal'}
      style={[
        StyleSheet.absoluteFill,
        styles.overlay,
        { backgroundColor: theme.colors.overlayBackdrop },
      ]}
    >
      {isTv ? <ModalTvKeyBridge onEvent={handleTvKey} /> : null}
      <Pressable
        testID="library-collection-modal-backdrop"
        accessibilityRole="button"
        accessibilityLabel={i18n.t('collections.cancel')}
        focusable={false}
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          styles.dialog,
          webBackdropBlur(20),
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.modal,
            padding: theme.spacing.lg,
            gap: theme.spacing.md,
          },
        ]}
      >
        <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>{title}</Text>

        {isDelete ? (
          <View style={styles.deleteBody}>
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {modal.name}
            </Text>
            <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
              {i18n.t('library.collections.deleteConfirmBody')}
            </Text>
          </View>
        ) : (
          <View
            testID="library-collection-name-input-wrapper"
            style={[
              styles.inputWrapper,
              {
                backgroundColor:
                  isTv && focusedSlot === 'input' ? theme.colors.focusFill : theme.colors.bgSurface,
                borderColor:
                  isTv && focusedSlot === 'input'
                    ? theme.colors.focusRingColor
                    : theme.colors.surfaceBorder,
                borderWidth: isTv && focusedSlot === 'input' ? theme.focus.ringWidth : 1,
                borderRadius: theme.radius.button,
              },
            ]}
          >
            <TextInput
              ref={inputRef}
              testID="library-collection-name-input"
              value={draftName}
              onChangeText={setDraftName}
              onFocus={() => setFocusedSlot('input')}
              placeholder={i18n.t('library.collections.namePlaceholder')}
              placeholderTextColor={theme.colors.textMuted}
              autoFocus={!isTv}
              maxLength={80}
              returnKeyType="done"
              onSubmitEditing={() => void handleConfirm()}
              accessibilityLabel={i18n.t('library.collections.namePlaceholder')}
              style={[theme.typography.body, styles.input, { color: theme.colors.textPrimary }]}
            />
          </View>
        )}

        <View style={styles.actions}>
          <CtaButton
            testID="library-collection-modal-cancel"
            variant="secondary"
            label={i18n.t('collections.cancel')}
            focusable={!isTv}
            focused={isTv && focusedSlot === 'cancel'}
            onPress={onClose}
          />
          {isDelete ? (
            <Pressable
              testID="library-collection-modal-confirm"
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              focusable={!isTv}
              disabled={submitting}
              onPress={() => void handleConfirm()}
              style={({ pressed }) => [
                styles.destructiveBtn,
                webCursorPointer(),
                {
                  borderRadius: theme.radius.button,
                  backgroundColor: theme.colors.liveColor,
                  borderColor:
                    isTv && focusedSlot === 'confirm'
                      ? theme.colors.focusRingColor
                      : theme.colors.liveColor,
                  borderWidth: isTv && focusedSlot === 'confirm' ? theme.focus.ringWidth : 1,
                  opacity: pressed || submitting ? 0.78 : 1,
                },
              ]}
            >
              <Text
                style={[
                  theme.typography.caption,
                  { color: theme.colors.accentContrast, fontWeight: '600' },
                ]}
              >
                {confirmLabel}
              </Text>
            </Pressable>
          ) : (
            <CtaButton
              testID="library-collection-modal-confirm"
              variant="primary"
              label={confirmLabel}
              disabled={submitting || validDraft === null}
              focusable={!isTv}
              focused={isTv && focusedSlot === 'confirm'}
              onPress={() => void handleConfirm()}
            />
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    zIndex: 60,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  dialog: {
    width: '100%',
    maxWidth: 440,
    borderWidth: 1,
    zIndex: 2,
  },
  deleteBody: {
    gap: 6,
  },
  inputWrapper: {
    minHeight: 42,
    justifyContent: 'center',
  },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 40,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 10,
  },
  destructiveBtn: {
    minHeight: 40,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
