import type { ProfileRecord } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import {
  Icon,
  IconButton,
  TextEntryBoundary,
  TvFocusGuideRegion,
  useFormFactor,
  useI18n,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useProfile } from '../shared';
import { ProfileAvatarTile } from './ProfileAvatarTile';
import { ProfileFormCard, type ProfileFormValues } from './ProfileFormCard';
import { ProfileTypeStepCard } from './ProfileTypeStepCard';
import {
  PickerTvKeyBridge,
  SubModalTvBackBridge,
  profilePickerStyles as styles,
} from './profile-picker-helpers';

/** Props of {@link ProfilePickerOverlay}. */
export interface ProfilePickerOverlayProps {
  readonly profiles: readonly ProfileRecord[];
  readonly activeProfileId: string;
  readonly onSelectProfile: (profileId: string) => void;
  /** Retained for caller compatibility; Wave P7 manages profiles inline inside this overlay. */
  readonly onManageInSettings?: () => void;
  readonly onClose: () => void;
  /** Optional flag opening directly onto the 2-step profile creation flow (`+ Add new`). */
  readonly startInAdd?: boolean;
  readonly onConsumeStartInAdd?: () => void;
  readonly testID?: string;
}

type SubModalState =
  | null
  | { readonly kind: 'add-type'; readonly selectedIsKids: boolean }
  | { readonly kind: 'add-details'; readonly isKids: boolean }
  | { readonly kind: 'edit'; readonly profileId: string };

/**
 * Redesigned Cinema Quietude v2 "Who's Watching?" overlay (`#15`, `#506`).
 * Renders large circular illustrated avatars, per-avatar edit pencils (hover on web, corner badge +
 * long-press on touch, focused action on TV), circular `+` Add profile (2-step Adult/Kids flow),
 * and an inline Edit Profile modal with name, 9 avatars, Kids toggle, PIN management, and Delete.
 */
export function ProfilePickerOverlay({
  profiles,
  activeProfileId,
  onSelectProfile,
  onClose,
  startInAdd = false,
  onConsumeStartInAdd,
  testID = 'profile-picker-overlay',
}: ProfilePickerOverlayProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const formFactor = useFormFactor();
  const viewport = useViewport();
  const isTv = formFactor === 'tv';
  const isWeb = (Platform.OS as string) === 'web';
  const isTouch = !isTv && !isWeb;

  const {
    hasGuardPin,
    hasParentalPin,
    guardPinProfileId,
    parentalUnlocked,
    parentalLoadError,
    pinDialog,
    createProfile,
    updateProfile,
    deleteProfile,
    hasProfilePin,
    requestParentalUnlock,
    openPinDialog,
  } = useProfile();

  const initialIdx = Math.max(
    0,
    profiles.findIndex((p) => p.id === activeProfileId),
  );

  const [tvZone, setTvZone] = useState<'tiles' | 'edit'>('tiles');
  const [tvIdx, setTvIdx] = useState(initialIdx);
  const [hoveredProfileId, setHoveredProfileId] = useState<string | null>(null);
  const [subModal, setSubModal] = useState<SubModalState>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createWithPin, setCreateWithPin] = useState(false);
  const [editingPinState, setEditingPinState] = useState<{
    readonly profileId: string;
    readonly hasPin: boolean;
  } | null>(null);

  const editingProfile =
    subModal?.kind === 'edit' ? (profiles.find((p) => p.id === subModal.profileId) ?? null) : null;
  const editingProfileId = editingProfile?.id ?? null;
  const editingProfileIdRef = useRef<string | null>(editingProfileId);
  editingProfileIdRef.current = editingProfileId;
  const reverifiedKidsOffProfileIdRef = useRef<string | null>(null);
  const reverifiedDeleteProfileIdRef = useRef<string | null>(null);

  const runProtected = useCallback(
    (action: () => void) => {
      if (parentalLoadError) return;
      if (hasGuardPin && !parentalUnlocked) {
        requestParentalUnlock(action);
        return;
      }
      action();
    },
    [hasGuardPin, parentalLoadError, parentalUnlocked, requestParentalUnlock],
  );

  const runReverified = useCallback(
    (action: () => void) => {
      if (parentalLoadError) return;
      if (hasGuardPin) {
        openPinDialog({
          mode: 'verify',
          title: i18n.t('parental.reverifyTitle'),
          profileId: guardPinProfileId ?? activeProfileId,
          verifyOnly: true,
          onSuccess: action,
        });
        return;
      }
      action();
    },
    [activeProfileId, guardPinProfileId, hasGuardPin, i18n, openPinDialog, parentalLoadError],
  );

  const openAddFlow = useCallback(() => {
    runProtected(() => {
      setConfirmDelete(false);
      setCreateWithPin(false);
      setSubModal({ kind: 'add-type', selectedIsKids: false });
    });
  }, [runProtected]);

  const consumedStartInAddRef = useRef(false);
  useEffect(() => {
    if (!startInAdd) {
      consumedStartInAddRef.current = false;
      return;
    }
    if (consumedStartInAddRef.current) return;
    consumedStartInAddRef.current = true;
    onConsumeStartInAdd?.();
    openAddFlow();
  }, [onConsumeStartInAdd, openAddFlow, startInAdd]);

  const openEditModal = useCallback(
    (profile: ProfileRecord) => {
      runProtected(() => {
        reverifiedKidsOffProfileIdRef.current = null;
        reverifiedDeleteProfileIdRef.current = null;
        setConfirmDelete(false);
        setEditingPinState(null);
        setSubModal({ kind: 'edit', profileId: profile.id });
      });
    },
    [runProtected],
  );

  const closeSubModal = useCallback(() => {
    reverifiedKidsOffProfileIdRef.current = null;
    reverifiedDeleteProfileIdRef.current = null;
    setConfirmDelete(false);
    setCreateWithPin(false);
    setEditingPinState(null);
    setSubModal(null);
    setTvZone('tiles');
  }, []);

  useEffect(() => {
    if (editingProfileId === null) {
      setEditingPinState(null);
      return undefined;
    }
    let cancelled = false;
    setEditingPinState((prev) => (prev?.profileId === editingProfileId ? prev : null));
    void hasProfilePin(editingProfileId).then((hasPin) => {
      if (!cancelled) {
        setEditingPinState({ profileId: editingProfileId, hasPin });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [editingProfileId, hasProfilePin]);

  useEffect(() => {
    if (tvIdx > profiles.length) {
      setTvIdx(Math.max(0, profiles.length - 1));
      setTvZone('tiles');
    }
  }, [profiles.length, tvIdx]);

  useEffect(() => {
    if (subModal?.kind === 'edit' && editingProfile === null) {
      setSubModal(null);
      setConfirmDelete(false);
      setTvZone('tiles');
    }
  }, [editingProfile, subModal]);

  const stateRef = useRef({ tvZone, tvIdx, count: profiles.length });
  stateRef.current = { tvZone, tvIdx, count: profiles.length };

  useEffect(() => {
    if (!isWeb || pinDialog !== null) return undefined;
    type WebKeyEvent = {
      key?: string;
      preventDefault?: () => void;
      stopPropagation?: () => void;
      stopImmediatePropagation?: () => void;
    };
    const host = globalThis as unknown as {
      addEventListener?: (
        type: string,
        listener: (e: WebKeyEvent) => void,
        capture?: boolean,
      ) => void;
      removeEventListener?: (
        type: string,
        listener: (e: WebKeyEvent) => void,
        capture?: boolean,
      ) => void;
    };
    if (
      typeof host.addEventListener !== 'function' ||
      typeof host.removeEventListener !== 'function'
    ) {
      return undefined;
    }
    const onKeyDown = (event: WebKeyEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault?.();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
        if (subModal !== null) {
          closeSubModal();
        } else {
          onClose();
        }
      }
    };
    host.addEventListener('keydown', onKeyDown, true);
    return () => host.removeEventListener?.('keydown', onKeyDown, true);
  }, [closeSubModal, isWeb, onClose, pinDialog, subModal]);

  const handleTvKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind === 'press' && event.key === 'back') {
        onClose();
        return true;
      }
      if (event.kind !== 'press' && event.kind !== 'repeat') return false;
      const cur = stateRef.current;

      if (event.kind === 'press' && event.key === 'menu') {
        const picked = profiles[cur.tvIdx];
        if (picked) {
          openEditModal(picked);
          return true;
        }
        return false;
      }

      if (cur.tvZone === 'tiles') {
        if (event.key === 'left') {
          setTvIdx(Math.max(0, cur.tvIdx - 1));
          return true;
        }
        if (event.key === 'right') {
          setTvIdx(Math.min(cur.count, cur.tvIdx + 1));
          return true;
        }
        if (event.key === 'down') {
          if (cur.tvIdx < cur.count) {
            setTvZone('edit');
            return true;
          }
          return false;
        }
        if (event.kind === 'press' && event.key === 'select') {
          if (cur.tvIdx === cur.count) {
            openAddFlow();
            return true;
          }
          const picked = profiles[cur.tvIdx];
          if (picked) onSelectProfile(picked.id);
          return true;
        }
        return false;
      }

      if (event.key === 'up') {
        setTvZone('tiles');
        return true;
      }
      if (event.key === 'left') {
        setTvIdx(Math.max(0, cur.tvIdx - 1));
        return true;
      }
      if (event.key === 'right') {
        setTvIdx(Math.min(Math.max(0, cur.count - 1), cur.tvIdx + 1));
        return true;
      }
      if (event.kind === 'press' && event.key === 'select') {
        const picked = profiles[cur.tvIdx];
        if (picked) openEditModal(picked);
        return true;
      }
      return false;
    },
    [onClose, onSelectProfile, openAddFlow, openEditModal, profiles],
  );

  const getProfileHasPin = useCallback(
    (targetProfileId: string): boolean =>
      editingPinState?.profileId === targetProfileId
        ? editingPinState.hasPin
        : targetProfileId === activeProfileId
          ? hasParentalPin
          : targetProfileId === guardPinProfileId,
    [activeProfileId, editingPinState, guardPinProfileId, hasParentalPin],
  );

  const handleSubmitCreate = useCallback(
    async (values: ProfileFormValues) => {
      if (parentalLoadError) return;
      const execute = async () => {
        setBusy(true);
        try {
          const shouldPromptPin = createWithPin || (values.isKids && !hasGuardPin);
          const res = await createProfile(values);
          if (res.ok) {
            closeSubModal();
            if (shouldPromptPin) {
              openPinDialog({
                mode: 'create',
                profileId: res.value.id,
              });
            }
          }
        } finally {
          setBusy(false);
        }
      };
      if (hasGuardPin && !parentalUnlocked) {
        runProtected(() => {
          void execute();
        });
        return;
      }
      await execute();
    },
    [
      closeSubModal,
      createProfile,
      createWithPin,
      hasGuardPin,
      openPinDialog,
      parentalLoadError,
      parentalUnlocked,
      runProtected,
    ],
  );

  const handleSubmitEdit = useCallback(
    async (profileId: string, values: ProfileFormValues) => {
      if (parentalLoadError) return;
      const execute = async () => {
        setBusy(true);
        try {
          const res = await updateProfile(profileId, values);
          if (res.ok) closeSubModal();
        } finally {
          setBusy(false);
        }
      };
      const targetProfile = profiles.find((p) => p.id === profileId);
      if (
        targetProfile?.isKids &&
        !values.isKids &&
        hasGuardPin &&
        reverifiedKidsOffProfileIdRef.current !== profileId
      ) {
        runReverified(() => {
          reverifiedKidsOffProfileIdRef.current = profileId;
          void execute();
        });
        return;
      }
      if (hasGuardPin && !parentalUnlocked) {
        runProtected(() => {
          void execute();
        });
        return;
      }
      await execute();
    },
    [
      closeSubModal,
      hasGuardPin,
      parentalLoadError,
      parentalUnlocked,
      profiles,
      runProtected,
      runReverified,
      updateProfile,
    ],
  );

  const handleConfirmDelete = useCallback(
    async (profileId: string) => {
      if (parentalLoadError) return;
      const execute = async () => {
        setBusy(true);
        try {
          const res = await deleteProfile(profileId);
          if (res.ok) closeSubModal();
        } finally {
          setBusy(false);
        }
      };
      const targetProfile = profiles.find((p) => p.id === profileId);
      const targetHasPin = getProfileHasPin(profileId);
      if (
        (targetProfile?.isKids || targetHasPin) &&
        hasGuardPin &&
        reverifiedDeleteProfileIdRef.current !== profileId
      ) {
        runReverified(() => {
          reverifiedDeleteProfileIdRef.current = profileId;
          void execute();
        });
        return;
      }
      if (hasGuardPin && !parentalUnlocked) {
        runProtected(() => {
          void execute();
        });
        return;
      }
      await execute();
    },
    [
      closeSubModal,
      deleteProfile,
      getProfileHasPin,
      hasGuardPin,
      parentalLoadError,
      parentalUnlocked,
      profiles,
      runProtected,
      runReverified,
    ],
  );

  const refreshEditingPinState = useCallback(
    (targetProfileId: string) => {
      void hasProfilePin(targetProfileId).then((hasPin) => {
        if (editingProfileIdRef.current === targetProfileId) {
          setEditingPinState({ profileId: targetProfileId, hasPin });
        }
      });
    },
    [hasProfilePin],
  );

  const buildEditPinSection = (targetProfileId: string) => {
    const profileHasPin = getProfileHasPin(targetProfileId);
    return {
      hasPin: profileHasPin,
      onSetPin: () =>
        runReverified(() =>
          openPinDialog({
            mode: 'create',
            profileId: targetProfileId,
            onSuccess: () => {
              setEditingPinState({ profileId: targetProfileId, hasPin: true });
              refreshEditingPinState(targetProfileId);
            },
          }),
        ),
      onChangePin: () => {
        if (parentalLoadError) return;
        openPinDialog({
          mode: 'change',
          profileId: targetProfileId,
          onSuccess: () => {
            refreshEditingPinState(targetProfileId);
          },
        });
      },
      onRemovePin: () => {
        if (parentalLoadError) return;
        openPinDialog({
          mode: 'remove',
          profileId: targetProfileId,
          onSuccess: () => {
            setEditingPinState({ profileId: targetProfileId, hasPin: false });
            refreshEditingPinState(targetProfileId);
          },
        });
      },
    };
  };

  const tileTransition = webTransition(theme, 'transform, background-color, border-color, opacity');
  const cursorPointer = webCursorPointer();
  const addFocused = isTv && tvZone === 'tiles' && tvIdx === profiles.length;

  return (
    <View
      testID={testID}
      style={[
        styles.backdrop,
        {
          backgroundColor: theme.colors.scrimStrong,
          paddingHorizontal: 24 + viewport.overscan.x,
          paddingVertical: 24 + viewport.overscan.y,
        },
        webBackdropBlur(24),
      ]}
    >
      {isTv && subModal === null && pinDialog === null ? (
        <PickerTvKeyBridge onEvent={handleTvKey} />
      ) : null}

      {!isTv ? (
        <View
          style={[
            styles.closeAnchor,
            { top: 20 + viewport.overscan.y, right: 20 + viewport.overscan.x },
          ]}
        >
          <IconButton
            testID="profile-picker-close"
            icon="close"
            accessibilityLabel={i18n.t('profiles.cancelAction')}
            onPress={onClose}
          />
        </View>
      ) : null}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.centerContent}
        showsVerticalScrollIndicator={false}
      >
        <Text
          testID="profile-picker-title"
          style={[
            isTv ? theme.typography.display : theme.typography.h1,
            styles.title,
            { color: theme.colors.textPrimary },
          ]}
        >
          {i18n.t('profiles.whoIsWatching')}
        </Text>

        <View style={[styles.grid, isTv ? styles.gridTv : null]}>
          {profiles.map((profile, idx) => (
            <ProfileAvatarTile
              key={profile.id}
              profile={profile}
              active={profile.id === activeProfileId}
              isTv={isTv}
              isWeb={isWeb}
              isTouch={isTouch}
              hovered={hoveredProfileId === profile.id}
              tileFocused={isTv && tvZone === 'tiles' && tvIdx === idx}
              editFocused={isTv && tvZone === 'edit' && tvIdx === idx}
              showTvEditPill={isTv && tvIdx === idx}
              onHoverIn={() => setHoveredProfileId(profile.id)}
              onHoverOut={() => setHoveredProfileId((prev) => (prev === profile.id ? null : prev))}
              onSelect={() => onSelectProfile(profile.id)}
              onEdit={() => openEditModal(profile)}
            />
          ))}

          <View style={styles.addWrap}>
            <Pressable
              testID="profile-picker-add"
              accessibilityRole="button"
              accessibilityLabel={i18n.t('profiles.addNew')}
              {...(isTv ? { focusable: false } : {})}
              onPress={openAddFlow}
              style={(state) => {
                const hovered = Boolean((state as { hovered?: boolean }).hovered);
                return [
                  styles.addCircle,
                  cursorPointer,
                  tileTransition,
                  {
                    borderRadius: theme.radius.pill,
                    backgroundColor: addFocused
                      ? theme.colors.focusFill
                      : hovered
                        ? theme.colors.actionGlassHoverBg
                        : theme.colors.bgSurface,
                    borderWidth: addFocused ? theme.focus.ringWidth : 1.5,
                    borderColor: addFocused
                      ? theme.colors.focusRingColor
                      : hovered
                        ? theme.colors.hoverRingBorder
                        : theme.colors.chipBorder,
                    transform: addFocused ? [{ scale: theme.focus.cardScale }] : undefined,
                  },
                ];
              }}
            >
              <Icon name="plus" size={38} color={theme.colors.textPrimary} />
            </Pressable>
            <Text
              numberOfLines={1}
              style={[
                theme.typography.title,
                styles.addLabel,
                { color: theme.colors.textSecondary },
              ]}
            >
              {i18n.t('profiles.addNew')}
            </Text>
          </View>
        </View>
      </ScrollView>

      {subModal !== null ? (
        <View
          testID="profile-submodal-backdrop"
          style={[
            styles.subModalBackdrop,
            {
              backgroundColor: theme.colors.overlayBackdrop,
              paddingHorizontal: 20 + viewport.overscan.x,
              paddingVertical: 20 + viewport.overscan.y,
            },
          ]}
        >
          <TextEntryBoundary>
            {isTv && pinDialog === null ? <SubModalTvBackBridge onBack={closeSubModal} /> : null}
            <TvFocusGuideRegion
              enabled={isTv && pinDialog === null}
              trapFocusLeft
              trapFocusRight
              trapFocusUp
              trapFocusDown
              style={styles.subModalContainer}
            >
              <ScrollView
                testID="profile-submodal-scroll"
                style={styles.subModalScroll}
                contentContainerStyle={styles.subModalScrollContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {subModal.kind === 'add-type' ? (
                  <ProfileTypeStepCard
                    selectedIsKids={subModal.selectedIsKids}
                    onSelectType={(selectedIsKids) =>
                      setSubModal({ kind: 'add-type', selectedIsKids })
                    }
                    onContinue={() => {
                      setCreateWithPin(subModal.selectedIsKids && !hasGuardPin);
                      setSubModal({ kind: 'add-details', isKids: subModal.selectedIsKids });
                    }}
                    onCancel={closeSubModal}
                  />
                ) : null}

                {subModal.kind === 'add-details' ? (
                  <View testID="profile-add-details-modal">
                    <ProfileFormCard
                      mode="create"
                      initialValues={{ isKids: subModal.isKids }}
                      showKidsToggle={false}
                      submitting={busy}
                      createPinOption={{
                        checked: createWithPin,
                        onToggle: () => setCreateWithPin((prev) => !prev),
                      }}
                      onSubmit={(values) => {
                        void handleSubmitCreate(values);
                      }}
                      onCancel={closeSubModal}
                    />
                  </View>
                ) : null}

                {subModal.kind === 'edit' && editingProfile !== null ? (
                  <View testID="profile-edit-modal">
                    <ProfileFormCard
                      mode="edit"
                      initialValues={{
                        name: editingProfile.name,
                        avatarToken: editingProfile.avatarToken,
                        isKids: editingProfile.isKids,
                      }}
                      showKidsToggle
                      onBeforeToggleKids={(nextIsKids, commit) => {
                        if (parentalLoadError) return;
                        if (editingProfile.isKids && !nextIsKids && hasGuardPin) {
                          runReverified(() => {
                            reverifiedKidsOffProfileIdRef.current = editingProfile.id;
                            commit();
                          });
                          return;
                        }
                        runProtected(commit);
                      }}
                      submitting={busy}
                      pinSection={buildEditPinSection(editingProfile.id)}
                      deleteSection={{
                        canDelete: profiles.length > 1,
                        confirming: confirmDelete,
                        onRequestDelete: () => {
                          if (parentalLoadError) return;
                          if (
                            (editingProfile.isKids || getProfileHasPin(editingProfile.id)) &&
                            hasGuardPin
                          ) {
                            runReverified(() => {
                              reverifiedDeleteProfileIdRef.current = editingProfile.id;
                              setConfirmDelete(true);
                            });
                            return;
                          }
                          runProtected(() => setConfirmDelete(true));
                        },
                        onConfirmDelete: () => {
                          void handleConfirmDelete(editingProfile.id);
                        },
                        onCancelDelete: () => setConfirmDelete(false),
                      }}
                      onSubmit={(values) => {
                        void handleSubmitEdit(editingProfile.id, values);
                      }}
                      onCancel={closeSubModal}
                    />
                  </View>
                ) : null}
              </ScrollView>
            </TvFocusGuideRegion>
          </TextEntryBoundary>
        </View>
      ) : null}
    </View>
  );
}
