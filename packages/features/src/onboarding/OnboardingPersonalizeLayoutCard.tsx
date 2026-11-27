import {
  type HomeLayoutSectionId,
  normalizeHomeLayout,
  type PreferencesPatch,
  type PreferencesSnapshot,
} from '@elv/domain';
import { Icon, IconButton, useI18n, useTheme, useViewport, webCursorPointer } from '@elv/ui-kit';
import { type ReactElement, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  moveOnboardingLayoutSection,
  ONBOARDING_HOME_SECTION_LABELS,
  resolveTipsMessageKeys,
  toggleOnboardingLayoutSection,
} from './onboarding-model';

const WIDE_SECTIONS = new Set<HomeLayoutSectionId>(['continue', 'newEpisodes', 'live']);

interface LayoutCardProps {
  readonly homeLayout: PreferencesSnapshot['homeLayout'];
  readonly onUpdatePreferences: (patch: PreferencesPatch) => void;
}

/**
 * Personalization Card 3 (`#513`): Live wireframe Home screen preview + section reorder/toggle.
 */
export function OnboardingPersonalizeLayoutCard({
  homeLayout,
  onUpdatePreferences,
}: LayoutCardProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const cursorPointer = webCursorPointer();

  const normalizedLayout = useMemo(() => normalizeHomeLayout(homeLayout), [homeLayout]);
  const visibleLayout = useMemo(
    () => normalizedLayout.filter((entry) => entry.visible),
    [normalizedLayout],
  );

  return (
    <View testID="onboarding-personalize-card-layout" style={styles.card}>
      <View style={styles.header}>
        <Text
          accessibilityRole="header"
          style={[theme.typography.h1, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('onboarding.personalize.layoutTitle')}
        </Text>
        <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
          {i18n.t('onboarding.personalize.layoutSubtitle')}
        </Text>
      </View>

      <View
        testID="onboarding-layout-preview"
        style={[
          styles.previewBox,
          {
            backgroundColor: theme.colors.bgCanvas,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.card,
          },
        ]}
      >
        <Text style={[theme.typography.micro, { color: theme.colors.textSecondary }]}>
          {i18n.t('onboarding.personalize.layoutPreviewLabel')}
        </Text>
        <View
          style={[
            styles.previewHero,
            {
              backgroundColor: theme.colors.bgElevated,
              borderColor: theme.colors.surfaceBorder,
              borderRadius: theme.radius.button,
            },
          ]}
        >
          <View style={[styles.previewHeroBar, { backgroundColor: theme.colors.accent }]} />
        </View>
        <View style={styles.previewRows}>
          {visibleLayout.slice(0, 4).map((section) => {
            const isWide = WIDE_SECTIONS.has(section.id);
            return (
              <View key={section.id} style={styles.previewRowItem}>
                <Text
                  numberOfLines={1}
                  style={[theme.typography.micro, { color: theme.colors.textMuted }]}
                >
                  {i18n.t(ONBOARDING_HOME_SECTION_LABELS[section.id])}
                </Text>
                <View style={styles.previewCards}>
                  {[0, 1, 2, 3].map((slot) => (
                    <View
                      key={slot}
                      style={[
                        isWide ? styles.previewWide : styles.previewPoster,
                        {
                          backgroundColor: theme.colors.bgSurface,
                          borderColor: theme.colors.surfaceBorder,
                        },
                      ]}
                    />
                  ))}
                </View>
              </View>
            );
          })}
        </View>
      </View>

      <View style={styles.layoutList}>
        {normalizedLayout.map((section, idx) => {
          const label = i18n.t(ONBOARDING_HOME_SECTION_LABELS[section.id]);
          return (
            <View
              key={section.id}
              testID={`onboarding-layout-row-${section.id}`}
              style={[
                styles.layoutRow,
                {
                  backgroundColor: theme.colors.bgCard,
                  borderColor: theme.colors.surfaceBorder,
                  borderRadius: theme.radius.button,
                  opacity: section.visible ? 1 : 0.6,
                },
              ]}
            >
              <Text
                numberOfLines={1}
                style={[
                  theme.typography.caption,
                  styles.flex1,
                  { color: theme.colors.textPrimary },
                ]}
              >
                {label}
              </Text>
              <View style={styles.rotateUp}>
                <IconButton
                  testID={`onboarding-layout-up-${section.id}`}
                  icon="chevronDown"
                  accessibilityLabel={i18n.t('settings.homeLayoutMoveUp')}
                  size={40}
                  disabled={idx === 0}
                  onPress={() =>
                    onUpdatePreferences({
                      homeLayout: moveOnboardingLayoutSection(normalizedLayout, idx, 'up'),
                    })
                  }
                />
              </View>
              <IconButton
                testID={`onboarding-layout-down-${section.id}`}
                icon="chevronDown"
                accessibilityLabel={i18n.t('settings.homeLayoutMoveDown')}
                size={40}
                disabled={idx === normalizedLayout.length - 1}
                onPress={() =>
                  onUpdatePreferences({
                    homeLayout: moveOnboardingLayoutSection(normalizedLayout, idx, 'down'),
                  })
                }
              />
              <Pressable
                testID={`onboarding-layout-toggle-${section.id}`}
                accessibilityRole="switch"
                accessibilityLabel={label}
                accessibilityState={{ checked: section.visible }}
                aria-checked={section.visible}
                focusable
                onPress={() =>
                  onUpdatePreferences({
                    homeLayout: toggleOnboardingLayoutSection(normalizedLayout, section.id),
                  })
                }
                style={(state) => [
                  styles.miniSwitchWrap,
                  cursorPointer,
                  {
                    borderRadius: theme.radius.pill,
                    borderWidth: state.focused ? theme.focus.ringWidth : 1,
                    borderColor: state.focused ? theme.colors.focusRingColor : 'transparent',
                    backgroundColor: state.focused ? theme.colors.focusFill : 'transparent',
                  },
                ]}
              >
                <View
                  style={[
                    styles.miniTrack,
                    {
                      borderRadius: theme.radius.pill,
                      backgroundColor: section.visible
                        ? theme.colors.accent
                        : theme.colors.bgSurface,
                      borderColor: section.visible ? theme.colors.accent : theme.colors.chipBorder,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.miniThumb,
                      {
                        borderRadius: theme.radius.pill,
                        backgroundColor: section.visible
                          ? theme.colors.accentContrast
                          : theme.colors.textPrimary,
                        alignSelf: section.visible ? 'flex-end' : 'flex-start',
                      },
                    ]}
                  />
                </View>
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Personalization Card 4 (`#513`): Platform-aware quick navigation & remote tips.
 */
export function OnboardingPersonalizeTipsCard(): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const [tip1Key, tip2Key] = resolveTipsMessageKeys(viewport.formFactor);

  return (
    <View testID="onboarding-personalize-card-tips" style={styles.card}>
      <View style={styles.header}>
        <Text
          accessibilityRole="header"
          style={[theme.typography.h1, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('onboarding.personalize.tipsTitle')}
        </Text>
        <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
          {i18n.t('onboarding.personalize.tipsSubtitle')}
        </Text>
      </View>

      {[
        { id: 'onboarding-tip-1', key: tip1Key },
        { id: 'onboarding-tip-2', key: tip2Key },
      ].map((tip) => (
        <View
          key={tip.id}
          testID={tip.id}
          style={[
            styles.tipCard,
            {
              backgroundColor: theme.colors.bgCard,
              borderColor: theme.colors.surfaceBorder,
              borderRadius: theme.radius.card,
            },
          ]}
        >
          <Icon name="check" size={18} color={theme.colors.accent} />
          <Text style={[theme.typography.body, styles.flex1, { color: theme.colors.textPrimary }]}>
            {i18n.t(tip.key)}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: '100%', gap: 14 },
  header: { gap: 4 },
  flex1: { flex: 1 },
  previewBox: { borderWidth: 1, padding: 10, gap: 6 },
  previewHero: { height: 22, borderWidth: 1, justifyContent: 'flex-end', padding: 4 },
  previewHeroBar: { width: 32, height: 3, borderRadius: 2 },
  previewRows: { gap: 5 },
  previewRowItem: { gap: 2 },
  previewCards: { flexDirection: 'row', gap: 5 },
  previewWide: { width: 36, height: 14, borderRadius: 2, borderWidth: 1 },
  previewPoster: { width: 18, height: 20, borderRadius: 2, borderWidth: 1 },
  layoutList: { gap: 6 },
  layoutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    gap: 6,
  },
  rotateUp: { transform: [{ rotate: '180deg' }] },
  miniSwitchWrap: {
    minWidth: 44,
    minHeight: 40,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniTrack: { width: 34, height: 20, borderWidth: 1, padding: 2, justifyContent: 'center' },
  miniThumb: { width: 14, height: 14 },
  tipCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
});
