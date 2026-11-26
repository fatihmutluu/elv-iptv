import { MAX_PROFILE_NAME_LENGTH, PROFILE_AVATAR_TOKENS, type ProfileAvatarToken } from '@elv/data';
import {
  CtaButton,
  Surface,
  TvTextInput,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ProfileAvatarBadge } from './ProfileAvatarBadge';

/** Submitted form payload for creating or updating a local profile. */
export interface ProfileFormValues {
  readonly name: string;
  readonly avatarToken: ProfileAvatarToken;
  readonly isKids: boolean;
}

/** Optional PIN management controls rendered inside {@link ProfileFormCard} in edit mode. */
export interface ProfileFormPinSection {
  readonly hasPin: boolean;
  readonly onSetPin: () => void;
  readonly onChangePin: () => void;
  readonly onRemovePin: () => void;
}

/** Optional opt-in toggle rendered inside {@link ProfileFormCard} in create mode. */
export interface ProfileFormCreatePinOption {
  readonly checked: boolean;
  readonly onToggle: () => void;
}

/** Optional Delete profile controls rendered inside {@link ProfileFormCard} in edit mode. */
export interface ProfileFormDeleteSection {
  readonly canDelete: boolean;
  readonly confirming: boolean;
  readonly onRequestDelete: () => void;
  readonly onConfirmDelete: () => void;
  readonly onCancelDelete: () => void;
}

/** Props of {@link ProfileFormCard}. */
export interface ProfileFormCardProps {
  readonly mode: 'create' | 'edit';
  readonly initialValues?: Partial<ProfileFormValues>;
  readonly submitting?: boolean;
  readonly showKidsToggle?: boolean;
  readonly onBeforeToggleKids?: (nextIsKids: boolean, commit: () => void) => void;
  readonly createPinOption?: ProfileFormCreatePinOption;
  readonly pinSection?: ProfileFormPinSection;
  readonly deleteSection?: ProfileFormDeleteSection;
  readonly onSubmit: (values: ProfileFormValues) => void;
  readonly onCancel: () => void;
}

/** Cinema Quietude v2 modal card for creating or editing a local viewer profile (`#15`, `#506`). */
export function ProfileFormCard({
  mode,
  initialValues,
  submitting = false,
  showKidsToggle = true,
  onBeforeToggleKids,
  createPinOption,
  pinSection,
  deleteSection,
  onSubmit,
  onCancel,
}: ProfileFormCardProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const [name, setName] = useState(initialValues?.name ?? '');
  const [avatarToken, setAvatarToken] = useState<ProfileAvatarToken>(
    initialValues?.avatarToken ?? 'crimson',
  );
  const [isKids, setIsKids] = useState(initialValues?.isKids ?? false);
  const [nameFocused, setNameFocused] = useState(false);
  const [focusedAvatar, setFocusedAvatar] = useState<ProfileAvatarToken | null>(null);
  const [kidsToggleFocused, setKidsToggleFocused] = useState(false);
  const [createPinFocused, setCreatePinFocused] = useState(false);

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && trimmed.length <= MAX_PROFILE_NAME_LENGTH && !submitting;
  const cursorPointer = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, transform');

  const handleToggleKids = () => {
    const nextValue = !isKids;
    const commit = () => setIsKids(nextValue);
    if (onBeforeToggleKids) {
      onBeforeToggleKids(nextValue, commit);
      return;
    }
    commit();
  };

  return (
    <Surface testID="profile-form-card" tone="card" bordered rounded="modal" style={styles.card}>
      <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
        {mode === 'create' ? i18n.t('profiles.addNew') : i18n.t('profiles.editProfileTitle')}
      </Text>

      <View style={styles.field}>
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {i18n.t('profiles.nameLabel')}
        </Text>
        <View
          testID="profile-form-name-frame"
          style={[
            styles.inputFrame,
            transition,
            {
              backgroundColor: nameFocused ? theme.colors.focusFill : theme.colors.bgSurface,
              borderColor: nameFocused ? theme.colors.focusRingColor : theme.colors.chipBorder,
              borderWidth: nameFocused ? theme.focus.ringWidth : 1,
              borderRadius: theme.radius.button,
            },
          ]}
        >
          <TvTextInput
            testID="profile-form-name-input"
            value={name}
            onChangeText={setName}
            maxLength={MAX_PROFILE_NAME_LENGTH}
            placeholder={i18n.t('profiles.namePlaceholder')}
            placeholderTextColor={theme.colors.textMuted}
            accessibilityLabel={i18n.t('profiles.nameLabel')}
            onFocus={() => setNameFocused(true)}
            onBlur={() => setNameFocused(false)}
            style={[theme.typography.body, styles.input, { color: theme.colors.textPrimary }]}
          />
        </View>
      </View>

      <View style={styles.field}>
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {i18n.t('profiles.avatarLabel')}
        </Text>
        <View testID="profile-avatar-grid" style={styles.avatarRow}>
          {PROFILE_AVATAR_TOKENS.map((token) => {
            const selected = avatarToken === token;
            return (
              <Pressable
                key={token}
                testID={`profile-avatar-option-${token}`}
                accessibilityRole="radio"
                accessibilityLabel={token}
                accessibilityState={{ selected }}
                focusable
                onFocus={() => setFocusedAvatar(token)}
                onBlur={() => setFocusedAvatar((prev) => (prev === token ? null : prev))}
                onPress={() => setAvatarToken(token)}
                style={(state) => {
                  const focused = focusedAvatar === token || Boolean(state.focused);
                  return [
                    styles.avatarChoice,
                    cursorPointer,
                    transition,
                    {
                      borderRadius: theme.radius.pill,
                      borderWidth: focused ? theme.focus.ringWidth : 2,
                      borderColor: focused
                        ? theme.colors.focusRingColor
                        : selected
                          ? theme.colors.accent
                          : 'transparent',
                      backgroundColor: focused
                        ? theme.colors.focusFill
                        : selected
                          ? theme.colors.subtleHighlight
                          : 'transparent',
                    },
                  ];
                }}
              >
                <ProfileAvatarBadge
                  name={trimmed || token}
                  avatarToken={token}
                  size="md"
                  active={selected}
                />
              </Pressable>
            );
          })}
        </View>
      </View>

      {showKidsToggle ? (
        <Pressable
          testID="profile-form-kids-toggle"
          accessibilityRole="switch"
          accessibilityLabel={i18n.t('profiles.kidsToggleLabel')}
          accessibilityState={{ checked: isKids }}
          aria-checked={isKids}
          focusable
          onFocus={() => setKidsToggleFocused(true)}
          onBlur={() => setKidsToggleFocused(false)}
          onPress={handleToggleKids}
          style={(state) => {
            const focused = kidsToggleFocused || Boolean(state.focused);
            return [
              styles.toggleRow,
              cursorPointer,
              transition,
              {
                borderRadius: theme.radius.card,
                backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgSurface,
                borderWidth: focused ? theme.focus.ringWidth : 1,
                borderColor: focused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
              },
            ];
          }}
        >
          <View style={styles.toggleText}>
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {i18n.t('profiles.kidsToggleLabel')}
            </Text>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('profiles.kidsHint')}
            </Text>
          </View>
          <View
            style={[
              styles.switchTrack,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: isKids ? theme.colors.accent : theme.colors.bgCard,
                borderColor: isKids ? theme.colors.accent : theme.colors.chipBorder,
              },
            ]}
          >
            <View
              style={[
                styles.switchThumb,
                {
                  borderRadius: theme.radius.pill,
                  backgroundColor: isKids ? theme.colors.accentContrast : theme.colors.textPrimary,
                  alignSelf: isKids ? 'flex-end' : 'flex-start',
                },
              ]}
            />
          </View>
        </Pressable>
      ) : null}

      {mode === 'create' && createPinOption !== undefined ? (
        <Pressable
          testID="profile-create-pin-toggle"
          accessibilityRole="checkbox"
          accessibilityLabel={i18n.t('profiles.setPinOnCreate')}
          accessibilityState={{ checked: createPinOption.checked }}
          aria-checked={createPinOption.checked}
          focusable
          onFocus={() => setCreatePinFocused(true)}
          onBlur={() => setCreatePinFocused(false)}
          onPress={createPinOption.onToggle}
          style={(state) => {
            const focused = createPinFocused || Boolean(state.focused);
            return [
              styles.toggleRow,
              cursorPointer,
              transition,
              {
                borderRadius: theme.radius.card,
                backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgSurface,
                borderWidth: focused ? theme.focus.ringWidth : 1,
                borderColor: focused ? theme.colors.focusRingColor : theme.colors.surfaceBorder,
              },
            ];
          }}
        >
          <View style={styles.toggleText}>
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {i18n.t('profiles.setPinOnCreate')}
            </Text>
          </View>
          <View
            style={[
              styles.switchTrack,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: createPinOption.checked
                  ? theme.colors.accent
                  : theme.colors.bgCard,
                borderColor: createPinOption.checked
                  ? theme.colors.accent
                  : theme.colors.chipBorder,
              },
            ]}
          >
            <View
              style={[
                styles.switchThumb,
                {
                  borderRadius: theme.radius.pill,
                  backgroundColor: createPinOption.checked
                    ? theme.colors.accentContrast
                    : theme.colors.textPrimary,
                  alignSelf: createPinOption.checked ? 'flex-end' : 'flex-start',
                },
              ]}
            />
          </View>
        </Pressable>
      ) : null}

      {pinSection !== undefined && mode === 'edit' ? (
        <View
          testID="profile-edit-pin-section"
          style={[
            styles.subSection,
            {
              backgroundColor: theme.colors.bgSurface,
              borderColor: theme.colors.surfaceBorder,
              borderRadius: theme.radius.card,
            },
          ]}
        >
          <View style={styles.subSectionText}>
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {i18n.t('profiles.pinManageLabel')}
            </Text>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {pinSection.hasPin ? i18n.t('parental.pinSet') : i18n.t('parental.pinNotSet')}
            </Text>
          </View>
          <View style={styles.subSectionActions}>
            {!pinSection.hasPin ? (
              <CtaButton
                testID="profile-edit-set-pin"
                variant="secondary"
                label={i18n.t('parental.setPin')}
                onPress={pinSection.onSetPin}
              />
            ) : (
              <>
                <CtaButton
                  testID="profile-edit-change-pin"
                  variant="secondary"
                  label={i18n.t('parental.changePin')}
                  onPress={pinSection.onChangePin}
                />
                <CtaButton
                  testID="profile-edit-remove-pin"
                  variant="secondary"
                  label={i18n.t('parental.removePin')}
                  onPress={pinSection.onRemovePin}
                />
              </>
            )}
          </View>
        </View>
      ) : null}

      {deleteSection !== undefined && mode === 'edit' ? (
        deleteSection.confirming ? (
          <View
            testID="profile-edit-delete-confirm"
            style={[
              styles.confirmBox,
              {
                borderColor: theme.colors.liveColor,
                borderRadius: theme.radius.card,
                backgroundColor: theme.colors.bgSurface,
              },
            ]}
          >
            <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
              {i18n.t('profiles.deleteConfirmTitle')}
            </Text>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('profiles.deleteConfirmBody')}
            </Text>
            <View style={styles.actions}>
              <CtaButton
                testID="profile-edit-delete-cancel"
                variant="secondary"
                label={i18n.t('profiles.cancelAction')}
                onPress={deleteSection.onCancelDelete}
              />
              <CtaButton
                testID="profile-edit-delete-confirm-btn"
                variant="primary"
                label={i18n.t('profiles.deleteProfileAction')}
                disabled={submitting}
                onPress={deleteSection.onConfirmDelete}
              />
            </View>
          </View>
        ) : (
          <View style={styles.deleteRow}>
            <CtaButton
              testID="profile-edit-delete"
              variant="secondary"
              label={i18n.t('profiles.deleteProfileAction')}
              disabled={!deleteSection.canDelete || submitting}
              onPress={deleteSection.onRequestDelete}
            />
            {!deleteSection.canDelete ? (
              <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
                {i18n.t('profiles.cannotDeleteLast')}
              </Text>
            ) : null}
          </View>
        )
      ) : null}

      <View style={styles.actions}>
        <CtaButton
          testID="profile-form-cancel"
          variant="secondary"
          label={i18n.t('profiles.cancelAction')}
          onPress={onCancel}
        />
        <CtaButton
          testID="profile-form-save"
          variant="primary"
          label={i18n.t('profiles.save')}
          disabled={!canSave}
          onPress={() => {
            if (canSave) onSubmit({ name: trimmed, avatarToken, isKids });
          }}
        />
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 20,
    gap: 14,
  },
  field: {
    gap: 6,
  },
  inputFrame: {
    minHeight: 42,
    borderWidth: 1,
    justifyContent: 'center',
  },
  input: {
    minHeight: 40,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  avatarRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  avatarChoice: {
    padding: 4,
    borderWidth: 2,
  },
  toggleRow: {
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  toggleText: {
    flex: 1,
    gap: 2,
  },
  switchTrack: {
    width: 38,
    height: 22,
    borderWidth: 1,
    padding: 2,
    justifyContent: 'center',
  },
  switchThumb: {
    width: 16,
    height: 16,
  },
  subSection: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  subSectionText: {
    flex: 1,
    minWidth: 150,
    gap: 2,
  },
  subSectionActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  deleteRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
  },
  confirmBox: {
    padding: 12,
    borderWidth: 1,
    gap: 8,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingTop: 4,
  },
});
