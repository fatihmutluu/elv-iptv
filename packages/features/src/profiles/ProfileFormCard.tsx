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

/** Props of {@link ProfileFormCard}. */
export interface ProfileFormCardProps {
  readonly mode: 'create' | 'edit';
  readonly initialValues?: Partial<ProfileFormValues>;
  readonly submitting?: boolean;
  readonly onSubmit: (values: ProfileFormValues) => void;
  readonly onCancel: () => void;
}

/** Inline Cinema Quietude v2 card for creating or editing a local viewer profile (`#15`). */
export function ProfileFormCard({
  mode,
  initialValues,
  submitting = false,
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

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && trimmed.length <= MAX_PROFILE_NAME_LENGTH && !submitting;
  const cursorPointer = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, transform');

  return (
    <Surface testID="profile-form-card" tone="card" bordered rounded="modal" style={styles.card}>
      <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
        {mode === 'create' ? i18n.t('profiles.addProfile') : i18n.t('profiles.editProfile')}
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
        <View style={styles.avatarRow}>
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
                  name={trimmed || 'P'}
                  avatarToken={token}
                  size="md"
                  active={selected}
                />
              </Pressable>
            );
          })}
        </View>
      </View>

      <Pressable
        testID="profile-form-kids-toggle"
        accessibilityRole="switch"
        accessibilityLabel={i18n.t('profiles.kidsToggle')}
        accessibilityState={{ checked: isKids }}
        aria-checked={isKids}
        focusable
        onFocus={() => setKidsToggleFocused(true)}
        onBlur={() => setKidsToggleFocused(false)}
        onPress={() => setIsKids((prev) => !prev)}
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
            {i18n.t('profiles.kidsToggle')}
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

      <View style={styles.actions}>
        <CtaButton
          testID="profile-form-cancel"
          variant="secondary"
          label={i18n.t('profiles.cancel')}
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
    padding: 16,
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
    gap: 10,
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
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingTop: 4,
  },
});
