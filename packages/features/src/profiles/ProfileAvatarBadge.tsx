import type { ProfileAvatarToken } from '@elv/data';
import { useI18n, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { getProfileInitials, resolveProfileAvatarColors } from './avatar-palette';

/** Size variant for {@link ProfileAvatarBadge}. */
export type ProfileAvatarSize = 'sm' | 'md' | 'lg';

/** Props of {@link ProfileAvatarBadge}. */
export interface ProfileAvatarBadgeProps {
  readonly name: string;
  readonly avatarToken: ProfileAvatarToken;
  readonly size?: ProfileAvatarSize;
  readonly isKids?: boolean;
  readonly showKidsPill?: boolean;
  readonly active?: boolean;
  readonly testID?: string;
}

const SIZE_MAP: Readonly<
  Record<ProfileAvatarSize, { readonly box: number; readonly font: number }>
> = {
  sm: { box: 28, font: 11.5 },
  md: { box: 42, font: 15 },
  lg: { box: 64, font: 22 },
};

/**
 * Circular Cinema Quietude v2 profile monogram badge (`#15`).
 * Derives every color dynamically from `theme` and `THEME_PRESETS` with zero hardcoded hex values.
 */
export function ProfileAvatarBadge({
  name,
  avatarToken,
  size = 'md',
  isKids = false,
  showKidsPill = false,
  active = false,
  testID,
}: ProfileAvatarBadgeProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const dims = SIZE_MAP[size];
  const colors = resolveProfileAvatarColors(avatarToken, theme);
  const initials = getProfileInitials(name);

  return (
    <View testID={testID} style={styles.wrap}>
      <View
        style={[
          styles.circle,
          {
            width: dims.box,
            height: dims.box,
            borderRadius: theme.radius.pill,
            backgroundColor: colors.bg,
            borderWidth: active ? 2 : 1,
            borderColor: active ? theme.colors.focusRingColor : theme.colors.glassBorder,
          },
        ]}
      >
        <Text
          numberOfLines={1}
          style={[
            styles.initials,
            {
              fontSize: Math.round(dims.font * theme.fontScale),
              color: colors.fg,
              ...(theme.typography.title.fontFamily
                ? { fontFamily: theme.typography.title.fontFamily }
                : {}),
            },
          ]}
        >
          {initials}
        </Text>
      </View>

      {isKids && showKidsPill ? (
        <View
          testID={testID ? `${testID}-kids` : undefined}
          style={[
            styles.kidsPill,
            {
              backgroundColor: theme.colors.bgElevated,
              borderColor: theme.colors.chipBorder,
              borderRadius: theme.radius.pill,
            },
          ]}
        >
          <Text style={[theme.typography.micro, { color: theme.colors.textPrimary }]}>
            {i18n.t('profiles.kidsBadge')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  kidsPill: {
    marginTop: -8,
    paddingHorizontal: 7,
    paddingVertical: 1.5,
    borderWidth: 1,
  },
});
