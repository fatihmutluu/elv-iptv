import { PROFILE_AVATAR_TOKENS, type ProfileAvatarToken, type ProfileRecord } from '@elv/data';
import type { PreferencesPatch, PreferencesSnapshot } from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import {
  THEME_PRESET_IDS,
  THEME_PRESETS,
  type ThemePresetId,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  OnboardingPersonalizeLayoutCard,
  OnboardingPersonalizeTipsCard,
} from './OnboardingPersonalizeLayoutCard';
import { OnboardingTextField } from './OnboardingPrimitives';
import type { PersonalizeCardIndex } from './onboarding-model';

const THEME_LABEL_KEYS: Readonly<Record<ThemePresetId, MessageId>> = {
  obsidianCrimson: 'settings.theme.obsidianCrimson.label',
  abyssalSapphire: 'settings.theme.abyssalSapphire.label',
  theaterAmber: 'settings.theme.theaterAmber.label',
  velvetViolet: 'settings.theme.velvetViolet.label',
  pitchEmerald: 'settings.theme.pitchEmerald.label',
  highContrast: 'settings.theme.highContrast.label',
};

const THEME_DESC_KEYS: Readonly<Record<ThemePresetId, MessageId>> = {
  obsidianCrimson: 'settings.theme.obsidianCrimson.desc',
  abyssalSapphire: 'settings.theme.abyssalSapphire.desc',
  theaterAmber: 'settings.theme.theaterAmber.desc',
  velvetViolet: 'settings.theme.velvetViolet.desc',
  pitchEmerald: 'settings.theme.pitchEmerald.desc',
  highContrast: 'settings.theme.highContrast.desc',
};

/** Slot props supplied to `renderAvatarPreview` to avoid importing `../profiles` directly. */
export interface OnboardingAvatarSlotProps {
  readonly name: string;
  readonly avatarToken: ProfileAvatarToken;
  readonly size: 'md' | 'lg';
  readonly active?: boolean;
}

/** Props of {@link OnboardingPersonalizeStep}. */
export interface OnboardingPersonalizeStepProps {
  readonly cardIndex: PersonalizeCardIndex;
  readonly preferences: PreferencesSnapshot;
  readonly onUpdatePreferences: (patch: PreferencesPatch) => void;
  readonly activeProfile: ProfileRecord;
  readonly onUpdateProfile: (
    id: string,
    patch: { readonly name?: string; readonly avatarToken?: ProfileAvatarToken },
  ) => void;
  readonly renderAvatarPreview: (slot: OnboardingAvatarSlotProps) => ReactElement;
}

/**
 * Onboarding Personalization Cards 1–4 (`#513`):
 * 1. Profile Name & 9 Avatars (updates `'default'` profile in place)
 * 2. Cinema Quietude Theme Palette (live swatch preview)
 * 3. Home Screen Layout (live wireframe mockup + reorder/toggle)
 * 4. Platform-Specific Quick Tips (`desktop` / `mobile` / `tv`)
 */
export function OnboardingPersonalizeStep({
  cardIndex,
  preferences,
  onUpdatePreferences,
  activeProfile,
  onUpdateProfile,
  renderAvatarPreview,
}: OnboardingPersonalizeStepProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();

  const [profileName, setProfileName] = useState(activeProfile.name);
  const latestDraftRef = useRef(profileName);
  latestDraftRef.current = profileName;
  const activeProfileRef = useRef(activeProfile);
  activeProfileRef.current = activeProfile;
  const onUpdateProfileRef = useRef(onUpdateProfile);
  onUpdateProfileRef.current = onUpdateProfile;
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevProfileIdRef = useRef(activeProfile.id);

  const commitProfileName = useCallback((rawName?: string) => {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    const trimmed = (rawName ?? latestDraftRef.current).trim();
    const current = activeProfileRef.current;
    if (trimmed.length > 0 && trimmed !== current.name) {
      onUpdateProfileRef.current(current.id, { name: trimmed });
    }
  }, []);

  useEffect(() => {
    if (prevProfileIdRef.current !== activeProfile.id) {
      prevProfileIdRef.current = activeProfile.id;
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      setProfileName(activeProfile.name);
    }
  }, [activeProfile.id, activeProfile.name]);

  useEffect(() => {
    if (cardIndex !== 0) {
      commitProfileName();
    }
  }, [cardIndex, commitProfileName]);

  useEffect(() => () => commitProfileName(), [commitProfileName]);

  const cursorPointer = webCursorPointer();
  const transition = webTransition(theme, 'transform, background-color, border-color');

  const handleNameChange = (next: string) => {
    setProfileName(next);
    latestDraftRef.current = next;
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      commitProfileName(next);
    }, 400);
  };

  return (
    <View testID="onboarding-personalize-step" style={styles.step}>
      <Text
        testID="onboarding-personalize-counter"
        style={[theme.typography.micro, { color: theme.colors.textMuted }]}
      >
        {i18n.t('onboarding.personalize.stepCounter', { step: cardIndex + 1, total: 4 })}
      </Text>

      {cardIndex === 0 ? (
        <View testID="onboarding-personalize-card-profile" style={styles.card}>
          <View style={styles.header}>
            <Text
              accessibilityRole="header"
              style={[theme.typography.h1, { color: theme.colors.textPrimary }]}
            >
              {i18n.t('onboarding.personalize.profileTitle')}
            </Text>
            <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
              {i18n.t('onboarding.personalize.profileSubtitle')}
            </Text>
          </View>

          <View style={styles.profileTopRow}>
            {renderAvatarPreview({
              name: profileName.trim() || activeProfile.name,
              avatarToken: activeProfile.avatarToken,
              size: 'lg',
              active: true,
            })}
            <View style={styles.flex1}>
              <OnboardingTextField
                testID="onboarding-profile-name-input"
                label={i18n.t('onboarding.personalize.profileNameLabel')}
                value={profileName}
                onChangeText={handleNameChange}
                onBlur={() => commitProfileName()}
                placeholder={i18n.t('profiles.namePlaceholder')}
              />
            </View>
          </View>

          <View style={styles.avatarSection}>
            <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
              {i18n.t('onboarding.personalize.avatarLabel')}
            </Text>
            <View style={styles.avatarGrid}>
              {PROFILE_AVATAR_TOKENS.map((token) => {
                const selected = activeProfile.avatarToken === token;
                return (
                  <Pressable
                    key={token}
                    testID={`onboarding-avatar-${token}`}
                    accessibilityRole="button"
                    accessibilityLabel={token}
                    accessibilityState={{ selected }}
                    aria-selected={selected}
                    focusable
                    onPress={() => onUpdateProfile(activeProfile.id, { avatarToken: token })}
                    style={(state) => [
                      styles.avatarChoice,
                      cursorPointer,
                      transition,
                      {
                        borderRadius: theme.radius.pill,
                        borderWidth: state.focused ? theme.focus.ringWidth : selected ? 2 : 1,
                        borderColor: state.focused
                          ? theme.colors.focusRingColor
                          : selected
                            ? theme.colors.accent
                            : theme.colors.surfaceBorder,
                        backgroundColor: state.focused ? theme.colors.focusFill : 'transparent',
                      },
                    ]}
                  >
                    {renderAvatarPreview({
                      name: activeProfile.name,
                      avatarToken: token,
                      size: 'md',
                      active: selected,
                    })}
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      ) : cardIndex === 1 ? (
        <View testID="onboarding-personalize-card-theme" style={styles.card}>
          <View style={styles.header}>
            <Text
              accessibilityRole="header"
              style={[theme.typography.h1, { color: theme.colors.textPrimary }]}
            >
              {i18n.t('onboarding.personalize.themeTitle')}
            </Text>
            <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
              {i18n.t('onboarding.personalize.themeSubtitle')}
            </Text>
          </View>

          <View style={styles.themeGrid}>
            {THEME_PRESET_IDS.map((presetId) => {
              const palette = THEME_PRESETS[presetId];
              const selected = preferences.themePreset === presetId;
              const label = i18n.t(THEME_LABEL_KEYS[presetId]);
              const desc = i18n.t(THEME_DESC_KEYS[presetId]);
              return (
                <Pressable
                  key={presetId}
                  testID={`onboarding-theme-${presetId}`}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ selected }}
                  aria-selected={selected}
                  focusable
                  onPress={() => onUpdatePreferences({ themePreset: presetId })}
                  style={(state) => [
                    styles.themeTile,
                    cursorPointer,
                    transition,
                    {
                      borderRadius: theme.radius.card,
                      backgroundColor: state.focused
                        ? theme.colors.focusFill
                        : selected
                          ? theme.colors.accentTint
                          : theme.colors.bgCard,
                      borderWidth: state.focused ? theme.focus.ringWidth : selected ? 1.5 : 1,
                      borderColor: state.focused
                        ? theme.colors.focusRingColor
                        : selected
                          ? theme.colors.accent
                          : theme.colors.surfaceBorder,
                    },
                  ]}
                >
                  <View style={styles.swatchRow}>
                    <View
                      style={[
                        styles.swatch,
                        { backgroundColor: palette.bgCanvas, borderColor: theme.colors.chipBorder },
                      ]}
                    />
                    <View
                      style={[
                        styles.swatch,
                        { backgroundColor: palette.bgCard, borderColor: theme.colors.chipBorder },
                      ]}
                    />
                    <View
                      style={[
                        styles.swatch,
                        { backgroundColor: palette.accent, borderColor: theme.colors.chipBorder },
                      ]}
                    />
                    <View
                      style={[
                        styles.swatch,
                        {
                          backgroundColor: palette.textPrimary,
                          borderColor: theme.colors.chipBorder,
                        },
                      ]}
                    />
                  </View>
                  <Text
                    numberOfLines={1}
                    style={[
                      theme.typography.title,
                      { color: theme.colors.textPrimary, fontWeight: selected ? '700' : '600' },
                    ]}
                  >
                    {label}
                  </Text>
                  <Text
                    numberOfLines={2}
                    style={[theme.typography.micro, { color: theme.colors.textSecondary }]}
                  >
                    {desc}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : cardIndex === 2 ? (
        <OnboardingPersonalizeLayoutCard
          homeLayout={preferences.homeLayout}
          onUpdatePreferences={onUpdatePreferences}
        />
      ) : (
        <OnboardingPersonalizeTipsCard />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  step: { width: '100%', gap: 10 },
  card: { width: '100%', gap: 14 },
  header: { gap: 4 },
  profileTopRow: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  flex1: { flex: 1 },
  avatarSection: { gap: 8 },
  avatarGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  avatarChoice: { padding: 4 },
  themeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  themeTile: { flexGrow: 1, flexBasis: '30%', minWidth: 155, padding: 10, gap: 6 },
  swatchRow: { flexDirection: 'row', gap: 5 },
  swatch: { width: 13, height: 13, borderRadius: 3, borderWidth: 1 },
});
