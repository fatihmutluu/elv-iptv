import type { CatalogService, ProfileRecord, SourceRow } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import {
  CtaButton,
  MicroPill,
  Surface,
  TextEntryBoundary,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useProfile } from '../shared';
import { ParentalControlsCard } from './ParentalControlsCard';
import { ProfileAvatarBadge } from './ProfileAvatarBadge';
import { ProfileFormCard, type ProfileFormValues } from './ProfileFormCard';

/** Props of {@link ProfilesAndParentalPanel}. */
export interface ProfilesAndParentalPanelProps {
  readonly catalog: CatalogService;
  readonly sources: readonly SourceRow[];
  /** Whether this Settings detail pane owns TV remote focus (`false` while sidebar or Top Nav owns focus). */
  readonly isActiveScope?: boolean;
  /** Returns TV focus from this panel back to the Settings sidebar. */
  readonly onBack?: () => void;
}

function ProfilesPanelTvBridge({ onBack }: { readonly onBack: () => void }): null {
  const handleKey = useCallback(
    (event: KeyEvent): boolean => {
      if (event.kind === 'press' && event.key === 'back') {
        onBack();
        return true;
      }
      return false;
    },
    [onBack],
  );
  useKeyInterpreter(handleKey);
  return null;
}

/**
 * Cinema Quietude v2 Settings section hosting Local Profile management (`#15`) and
 * PIN-protected Parental Controls (`#31`).
 */
export function ProfilesAndParentalPanel({
  catalog,
  sources,
  isActiveScope = true,
  onBack,
}: ProfilesAndParentalPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv';

  const {
    profiles,
    activeProfile,
    activeProfileId,
    parentalSettings,
    hasGuardPin,
    guardPinProfileId,
    parentalUnlocked,
    switchProfile,
    createProfile,
    updateProfile,
    deleteProfile,
    requestParentalUnlock,
    openPinDialog,
  } = useProfile();

  const [formMode, setFormMode] = useState<'closed' | 'create' | 'edit'>('closed');
  const [editingProfile, setEditingProfile] = useState<ProfileRecord | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Immediately dismiss open profile edit/create/delete UI if parental controls re-lock
  // (timeout expiry, background/hide re-lock, or tapping Lock now below).
  useEffect(() => {
    if (hasGuardPin && !parentalUnlocked) {
      setFormMode('closed');
      setEditingProfile(null);
      setConfirmDeleteId(null);
    }
  }, [hasGuardPin, parentalUnlocked]);

  const runProtected = useCallback(
    (action: () => void) => {
      if (hasGuardPin && !parentalUnlocked) {
        requestParentalUnlock(action);
        return;
      }
      action();
    },
    [hasGuardPin, parentalUnlocked, requestParentalUnlock],
  );

  const handleSwitchProfile = useCallback(
    (targetId: string) => {
      if (targetId === activeProfileId) return;
      const needsPinGate =
        (activeProfile.isKids || parentalSettings.enabled) && hasGuardPin && !parentalUnlocked;
      if (needsPinGate) {
        openPinDialog({
          mode: 'verify',
          profileId: guardPinProfileId ?? activeProfileId,
          verifyOnly: true,
          onSuccess: () => {
            void switchProfile(targetId);
          },
        });
        return;
      }
      void switchProfile(targetId);
    },
    [
      activeProfile.isKids,
      activeProfileId,
      guardPinProfileId,
      hasGuardPin,
      openPinDialog,
      parentalSettings.enabled,
      parentalUnlocked,
      switchProfile,
    ],
  );

  const handleSubmitForm = useCallback(
    async (values: ProfileFormValues) => {
      const execute = async () => {
        setBusy(true);
        try {
          if (formMode === 'create') {
            const res = await createProfile(values);
            if (res.ok) {
              setFormMode('closed');
            }
          } else if (formMode === 'edit' && editingProfile !== null) {
            const res = await updateProfile(editingProfile.id, values);
            if (res.ok) {
              setFormMode('closed');
              setEditingProfile(null);
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
      createProfile,
      editingProfile,
      formMode,
      hasGuardPin,
      parentalUnlocked,
      runProtected,
      updateProfile,
    ],
  );

  const handleConfirmDelete = useCallback(
    async (profileId: string) => {
      const execute = async () => {
        setBusy(true);
        try {
          const res = await deleteProfile(profileId);
          if (res.ok) {
            setConfirmDeleteId(null);
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
    [deleteProfile, hasGuardPin, parentalUnlocked, runProtected],
  );

  const isOnlyProfile = profiles.length <= 1;
  const cursorPointer = webCursorPointer();
  const rowTransition = webTransition(theme, 'background-color, border-color');

  return (
    <TextEntryBoundary>
      <ScrollView
        testID="settings-panel-profiles"
        style={styles.scroll}
        contentContainerStyle={[styles.content, { gap: theme.spacing.md }]}
      >
        {isTv && isActiveScope && onBack !== undefined ? (
          <ProfilesPanelTvBridge onBack={onBack} />
        ) : null}

        <Surface
          testID="profiles-management-card"
          tone="surface"
          bordered
          rounded="modal"
          style={styles.sectionCard}
        >
          <View style={styles.sectionHeader}>
            <View style={styles.headerText}>
              <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
                {i18n.t('profiles.title')}
              </Text>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {i18n.t('profiles.subtitle')}
              </Text>
            </View>
            <CtaButton
              testID="profiles-add-button"
              variant="primary"
              label={i18n.t('profiles.addProfile')}
              hasTVPreferredFocus={isTv && isActiveScope}
              onPress={() =>
                runProtected(() => {
                  setEditingProfile(null);
                  setConfirmDeleteId(null);
                  setFormMode('create');
                })
              }
            />
          </View>

          {formMode !== 'closed' ? (
            <ProfileFormCard
              mode={formMode}
              {...(formMode === 'edit' && editingProfile !== null
                ? {
                    initialValues: {
                      name: editingProfile.name,
                      avatarToken: editingProfile.avatarToken,
                      isKids: editingProfile.isKids,
                    },
                  }
                : {})}
              submitting={busy}
              onSubmit={(values) => {
                void handleSubmitForm(values);
              }}
              onCancel={() => {
                setFormMode('closed');
                setEditingProfile(null);
              }}
            />
          ) : null}

          <View style={styles.profileList}>
            {profiles.map((profile) => {
              const isActive = profile.id === activeProfileId;
              const confirmingDelete = confirmDeleteId === profile.id;
              const isRowFocused = focusedRowId === profile.id;
              return (
                <View
                  key={profile.id}
                  testID={`profile-row-${profile.id}`}
                  style={[
                    styles.profileRow,
                    rowTransition,
                    {
                      borderRadius: theme.radius.card,
                      backgroundColor: isRowFocused
                        ? theme.colors.focusFill
                        : isActive
                          ? theme.colors.subtleHighlight
                          : theme.colors.bgCard,
                      borderWidth: isRowFocused ? theme.focus.ringWidth : 1,
                      borderColor: isRowFocused
                        ? theme.colors.focusRingColor
                        : isActive
                          ? theme.colors.accent
                          : theme.colors.surfaceBorder,
                    },
                  ]}
                >
                  <View style={styles.profileRowMain}>
                    <Pressable
                      testID={`profile-card-select-${profile.id}`}
                      accessibilityRole="button"
                      accessibilityLabel={profile.name}
                      accessibilityState={{ selected: isActive }}
                      focusable={!isActive}
                      disabled={isActive}
                      onFocus={() => setFocusedRowId(profile.id)}
                      onBlur={() => setFocusedRowId((prev) => (prev === profile.id ? null : prev))}
                      onPress={() => handleSwitchProfile(profile.id)}
                      style={[styles.profileIdentity, !isActive ? cursorPointer : undefined]}
                    >
                      <ProfileAvatarBadge
                        name={profile.name}
                        avatarToken={profile.avatarToken}
                        size="md"
                        isKids={profile.isKids}
                        active={isActive}
                      />
                      <View style={styles.profileMeta}>
                        <View style={styles.nameBadgeRow}>
                          <Text
                            numberOfLines={1}
                            style={[theme.typography.title, { color: theme.colors.textPrimary }]}
                          >
                            {profile.name}
                          </Text>
                          {isActive ? (
                            <MicroPill
                              testID={`profile-active-badge-${profile.id}`}
                              label={i18n.t('profiles.activeBadge')}
                              tone="accent"
                            />
                          ) : null}
                          {profile.isKids ? (
                            <MicroPill
                              testID={`profile-kids-badge-${profile.id}`}
                              label={i18n.t('profiles.kidsBadge')}
                            />
                          ) : null}
                        </View>
                      </View>
                    </Pressable>
                    <View style={styles.profileActions}>
                      {!isActive ? (
                        <CtaButton
                          testID={`profile-switch-${profile.id}`}
                          variant="secondary"
                          label={i18n.t('profiles.switchButton')}
                          onPress={() => handleSwitchProfile(profile.id)}
                        />
                      ) : null}
                      <CtaButton
                        testID={`profile-edit-${profile.id}`}
                        variant="secondary"
                        label={i18n.t('profiles.editProfile')}
                        onPress={() =>
                          runProtected(() => {
                            setConfirmDeleteId(null);
                            setEditingProfile(profile);
                            setFormMode('edit');
                          })
                        }
                      />
                      <CtaButton
                        testID={`profile-delete-${profile.id}`}
                        variant="secondary"
                        label={i18n.t('profiles.deleteProfile')}
                        disabled={isOnlyProfile}
                        onPress={() =>
                          runProtected(() => {
                            setFormMode('closed');
                            setConfirmDeleteId(profile.id);
                          })
                        }
                      />
                    </View>
                  </View>

                  {confirmingDelete ? (
                    <View
                      testID={`profile-delete-confirm-${profile.id}`}
                      style={[
                        styles.confirmBox,
                        {
                          borderColor: theme.colors.liveColor,
                          borderRadius: theme.radius.button,
                          backgroundColor: theme.colors.bgSurface,
                        },
                      ]}
                    >
                      <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
                        {i18n.t('profiles.deleteConfirmTitle')}
                      </Text>
                      <Text
                        style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                      >
                        {i18n.t('profiles.deleteConfirmBody')}
                      </Text>
                      <View style={styles.confirmActions}>
                        <CtaButton
                          testID={`profile-delete-cancel-${profile.id}`}
                          variant="secondary"
                          label={i18n.t('profiles.cancel')}
                          onPress={() => setConfirmDeleteId(null)}
                        />
                        <CtaButton
                          testID={`profile-delete-confirm-btn-${profile.id}`}
                          variant="primary"
                          label={i18n.t('profiles.deleteProfile')}
                          disabled={busy}
                          onPress={() => {
                            void handleConfirmDelete(profile.id);
                          }}
                        />
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>

          {isOnlyProfile ? (
            <Text
              testID="profiles-cannot-delete-last-hint"
              style={[theme.typography.caption, { color: theme.colors.textMuted }]}
            >
              {i18n.t('profiles.cannotDeleteLast')}
            </Text>
          ) : null}
        </Surface>

        <ParentalControlsCard catalog={catalog} sources={sources} />
      </ScrollView>
    </TextEntryBoundary>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingBottom: 24 },
  sectionCard: { padding: 18, gap: 14 },
  sectionHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerText: { flex: 1, minWidth: 200, gap: 4 },
  profileList: { gap: 10 },
  profileRow: {
    padding: 12,
    borderWidth: 1,
    gap: 10,
  },
  profileRowMain: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
  },
  profileIdentity: {
    flex: 1,
    minWidth: 180,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  profileMeta: { flex: 1, minWidth: 140 },
  nameBadgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  profileActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  confirmBox: {
    padding: 12,
    borderWidth: 1,
    gap: 8,
  },
  confirmActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
});
