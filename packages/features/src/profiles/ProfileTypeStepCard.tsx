import {
  CtaButton,
  Surface,
  useI18n,
  useTheme,
  webCursorPointer,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/** Props of {@link ProfileTypeStepCard}. */
export interface ProfileTypeStepCardProps {
  readonly selectedIsKids: boolean;
  readonly onSelectType: (isKids: boolean) => void;
  readonly onContinue: () => void;
  readonly onCancel: () => void;
}

/** Step 1 modal card of the `+` Add Profile flow: choose Standard (Adult) or Kids profile (`#506`). */
export function ProfileTypeStepCard({
  selectedIsKids,
  onSelectType,
  onContinue,
  onCancel,
}: ProfileTypeStepCardProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const [focusedChoice, setFocusedChoice] = useState<'adult' | 'kids' | null>(null);
  const cursorPointer = webCursorPointer();
  const transition = webTransition(theme, 'background-color, border-color, transform');

  const options = [
    {
      key: 'adult' as const,
      isKids: false,
      testID: 'profile-type-adult',
      title: i18n.t('profiles.typeAdultTitle'),
      description: i18n.t('profiles.typeAdultDesc'),
    },
    {
      key: 'kids' as const,
      isKids: true,
      testID: 'profile-type-kids',
      title: i18n.t('profiles.typeKidsTitle'),
      description: i18n.t('profiles.typeKidsDesc'),
    },
  ];

  return (
    <Surface
      testID="profile-add-type-modal"
      tone="card"
      bordered
      rounded="modal"
      style={styles.card}
    >
      <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
        {i18n.t('profiles.chooseTypeTitle')}
      </Text>

      <View style={styles.options}>
        {options.map((opt) => {
          const selected = selectedIsKids === opt.isKids;
          return (
            <Pressable
              key={opt.key}
              testID={opt.testID}
              accessibilityRole="radio"
              accessibilityLabel={opt.title}
              accessibilityState={{ selected }}
              focusable
              onFocus={() => setFocusedChoice(opt.key)}
              onBlur={() => setFocusedChoice((prev) => (prev === opt.key ? null : prev))}
              onPress={() => onSelectType(opt.isKids)}
              style={(state) => {
                const focused = focusedChoice === opt.key || Boolean(state.focused);
                return [
                  styles.optionCard,
                  cursorPointer,
                  transition,
                  {
                    borderRadius: theme.radius.card,
                    backgroundColor: focused
                      ? theme.colors.focusFill
                      : selected
                        ? theme.colors.subtleHighlight
                        : theme.colors.bgSurface,
                    borderWidth: focused ? theme.focus.ringWidth : selected ? 2 : 1,
                    borderColor: focused
                      ? theme.colors.focusRingColor
                      : selected
                        ? theme.colors.accent
                        : theme.colors.surfaceBorder,
                  },
                ];
              }}
            >
              <View style={styles.optionHeader}>
                <View
                  style={[
                    styles.radioOuter,
                    {
                      borderRadius: theme.radius.pill,
                      borderColor: selected ? theme.colors.accent : theme.colors.chipBorder,
                    },
                  ]}
                >
                  {selected ? (
                    <View
                      style={[
                        styles.radioInner,
                        {
                          borderRadius: theme.radius.pill,
                          backgroundColor: theme.colors.accent,
                        },
                      ]}
                    />
                  ) : null}
                </View>
                <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
                  {opt.title}
                </Text>
              </View>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {opt.description}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.actions}>
        <CtaButton
          testID="profile-type-cancel"
          variant="secondary"
          label={i18n.t('profiles.cancelAction')}
          onPress={onCancel}
        />
        <CtaButton
          testID="profile-type-continue"
          variant="primary"
          label={i18n.t('profiles.continueAction')}
          onPress={onContinue}
        />
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 20,
    gap: 16,
  },
  options: {
    gap: 10,
  },
  optionCard: {
    padding: 14,
    gap: 6,
  },
  optionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  radioOuter: {
    width: 18,
    height: 18,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioInner: {
    width: 8,
    height: 8,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    paddingTop: 4,
  },
});
