import type { ProfileRecord } from '@elv/data';
import {
  MicroPill,
  Tooltip,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PENCIL_ICON_SPEC } from './avatar-palette';
import { ProfileAvatarBadge, VectorSpecGraphic } from './ProfileAvatarBadge';

/** Props of {@link ProfileAvatarTile}. */
export interface ProfileAvatarTileProps {
  readonly profile: ProfileRecord;
  readonly active: boolean;
  readonly isTv: boolean;
  readonly isWeb: boolean;
  readonly isTouch: boolean;
  readonly hovered: boolean;
  readonly tileFocused: boolean;
  readonly editFocused: boolean;
  readonly showTvEditPill: boolean;
  readonly onHoverIn: () => void;
  readonly onHoverOut: () => void;
  readonly onSelect: () => void;
  readonly onEdit: () => void;
}

/**
 * Single circular profile tile inside the "Who's Watching?" overlay (`#15`, `#506`).
 * Surfaces a hover pencil on web, corner pencil + long-press on touch, and focused edit pill on TV.
 */
export function ProfileAvatarTile({
  profile,
  active,
  isTv,
  isWeb,
  isTouch,
  hovered,
  tileFocused,
  editFocused,
  showTvEditPill,
  onHoverIn,
  onHoverOut,
  onSelect,
  onEdit,
}: ProfileAvatarTileProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const tileTransition = webTransition(theme, 'transform, background-color, border-color, opacity');
  const cursorPointer = webCursorPointer();

  const showCornerPencil = isTouch || (isWeb && !isTv && hovered);

  const pencilButton = (
    <Pressable
      testID={`profile-picker-edit-${profile.id}`}
      accessibilityRole="button"
      accessibilityLabel={i18n.t('profiles.editProfileTitle')}
      focusable={!isTv}
      onPress={(event) => {
        event?.stopPropagation?.();
        onEdit();
      }}
      style={[
        styles.cornerPencil,
        cursorPointer,
        tileTransition,
        {
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.bgElevated,
          borderColor: theme.colors.glassBorder,
        },
      ]}
    >
      <VectorSpecGraphic
        spec={PENCIL_ICON_SPEC}
        size={15}
        color={theme.colors.textPrimary}
        strokeWidth={1.9}
        testID={`profile-picker-edit-icon-${profile.id}`}
      />
    </Pressable>
  );

  return (
    <Pressable
      testID={`profile-picker-tile-${profile.id}`}
      accessible={false}
      focusable={false}
      onHoverIn={onHoverIn}
      onHoverOut={onHoverOut}
      style={styles.tileWrap}
    >
      <View style={styles.avatarStage}>
        <Pressable
          testID={`profile-picker-card-${profile.id}`}
          accessibilityRole="button"
          accessibilityLabel={profile.name}
          accessibilityState={{ selected: active }}
          {...(isTv ? { focusable: false } : {})}
          onPress={onSelect}
          onLongPress={isTouch ? onEdit : undefined}
          style={[
            styles.avatarButton,
            cursorPointer,
            tileTransition,
            {
              borderRadius: theme.radius.pill,
              borderWidth: tileFocused ? theme.focus.ringWidth : 2,
              borderColor: tileFocused
                ? theme.colors.focusRingColor
                : active
                  ? theme.colors.accent
                  : 'transparent',
              transform: tileFocused ? [{ scale: theme.focus.cardScale }] : undefined,
            },
          ]}
        >
          <ProfileAvatarBadge
            name={profile.name}
            avatarToken={profile.avatarToken}
            size="xl"
            isKids={profile.isKids}
            active={active}
            testID={`profile-picker-avatar-${profile.id}`}
          />
        </Pressable>

        {showCornerPencil ? (
          <View style={styles.cornerPencilAnchor}>
            {isWeb ? (
              <Tooltip content={i18n.t('profiles.editProfileTitle')}>{pencilButton}</Tooltip>
            ) : (
              pencilButton
            )}
          </View>
        ) : null}
      </View>

      <Text
        numberOfLines={1}
        style={[theme.typography.title, styles.profileName, { color: theme.colors.textPrimary }]}
      >
        {profile.name}
      </Text>

      {profile.isKids ? (
        <MicroPill
          testID={`profile-picker-kids-${profile.id}`}
          label={i18n.t('profiles.kidsBadge')}
        />
      ) : null}

      {showTvEditPill ? (
        <Pressable
          testID={`profile-picker-edit-${profile.id}`}
          accessibilityRole="button"
          accessibilityLabel={i18n.t('profiles.editProfileTitle')}
          focusable={false}
          onPress={onEdit}
          style={[
            styles.tvEditPill,
            {
              borderRadius: theme.radius.pill,
              backgroundColor: editFocused ? theme.colors.focusFill : theme.colors.chipBg,
              borderWidth: editFocused ? theme.focus.ringWidth : 1,
              borderColor: editFocused ? theme.colors.focusRingColor : theme.colors.chipBorder,
            },
          ]}
        >
          <VectorSpecGraphic
            spec={PENCIL_ICON_SPEC}
            size={13}
            color={theme.colors.textPrimary}
            strokeWidth={1.8}
            testID={`profile-picker-tv-edit-icon-${profile.id}`}
          />
          <Text style={[theme.typography.micro, { color: theme.colors.textPrimary }]}>
            {i18n.t('profiles.editProfileTitle')}
          </Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tileWrap: {
    width: 132,
    alignItems: 'center',
    gap: 10,
  },
  avatarStage: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarButton: {
    padding: 4,
  },
  cornerPencilAnchor: {
    position: 'absolute',
    top: 2,
    right: 2,
    zIndex: 4,
  },
  cornerPencil: {
    width: 32,
    height: 32,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tvEditPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  profileName: {
    textAlign: 'center',
    maxWidth: 132,
  },
});
