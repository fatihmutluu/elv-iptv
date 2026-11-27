import {
  CtaButton,
  QrCodeView,
  TABULAR_NUMS_STYLE,
  TvTextInput,
  useI18n,
  useTheme,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import type { SyncQrPairingState } from './account-helpers';

/** Props of {@link AccountTextField}. */
export interface AccountTextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  readonly placeholder?: string;
  readonly secureTextEntry?: boolean;
  readonly keyboardType?: 'default' | 'email-address' | 'url';
  readonly autoComplete?: 'email' | 'password' | 'new-password' | 'off';
  readonly editable?: boolean;
  readonly onFocus?: () => void;
  readonly testID: string;
}

/** Cinema Quietude framed text input integrated with TV remote text-entry suspension. */
export function AccountTextField({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry = false,
  keyboardType = 'default',
  autoComplete = 'off',
  editable = true,
  onFocus,
  testID,
}: AccountTextFieldProps): ReactElement {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const transition = webTransition(theme, 'background-color, border-color');

  return (
    <View style={styles.field}>
      <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>{label}</Text>
      <View
        testID={`${testID}-frame`}
        style={[
          styles.inputFrame,
          transition,
          {
            backgroundColor: focused ? theme.colors.focusFill : theme.colors.bgSurface,
            borderColor: focused ? theme.colors.focusRingColor : theme.colors.chipBorder,
            borderWidth: focused ? theme.focus.ringWidth : 1,
            borderRadius: theme.radius.button,
          },
        ]}
      >
        <TvTextInput
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textMuted}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete={autoComplete}
          editable={editable}
          accessibilityLabel={label}
          onFocus={() => {
            setFocused(true);
            onFocus?.();
          }}
          onBlur={() => setFocused(false)}
          style={[theme.typography.body, styles.input, { color: theme.colors.textPrimary }]}
        />
      </View>
    </View>
  );
}

/** Props of {@link AccountRecoveryBanner}. */
export interface AccountRecoveryBannerProps {
  readonly recoveryCode: string;
  readonly onAcknowledge: () => void;
  readonly testIDPrefix?: string;
  readonly hasTVPreferredFocus?: boolean;
}

/** High-clarity offline recovery code display shown after E2EE registration (`#26`). */
export function AccountRecoveryBanner({
  recoveryCode,
  onAcknowledge,
  testIDPrefix = 'account',
  hasTVPreferredFocus = false,
}: AccountRecoveryBannerProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

  return (
    <View
      testID={`${testIDPrefix}-recovery-banner`}
      style={[
        styles.recoveryBox,
        {
          backgroundColor: theme.colors.bgCard,
          borderColor: theme.colors.accent,
          borderRadius: theme.radius.card,
        },
      ]}
    >
      <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
        {i18n.t('account.recoveryTitle')}
      </Text>
      <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
        {i18n.t('account.recoveryBody')}
      </Text>
      <View
        style={[
          styles.codeBox,
          {
            backgroundColor: theme.colors.bgCanvas,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.button,
          },
        ]}
      >
        <Text
          testID={`${testIDPrefix}-recovery-code`}
          selectable
          style={[
            theme.typography.title,
            TABULAR_NUMS_STYLE,
            { color: theme.colors.textPrimary, fontFamily: monoFont, textAlign: 'center' },
          ]}
        >
          {recoveryCode}
        </Text>
      </View>
      <CtaButton
        testID={`${testIDPrefix}-recovery-saved-btn`}
        variant="primary"
        label={i18n.t('account.recoverySavedAction')}
        hasTVPreferredFocus={hasTVPreferredFocus}
        onPress={onAcknowledge}
      />
    </View>
  );
}

/** Props of {@link AccountQrPairingView}. */
export interface AccountQrPairingViewProps {
  readonly pairing: SyncQrPairingState;
  readonly size?: number;
  readonly testIDPrefix?: string;
}

/** Live universal QR pairing display (`<= 213` bytes) with expiry & regenerate support (`#26`). */
export function AccountQrPairingView({
  pairing,
  size = 180,
  testIDPrefix = 'sync-qr',
}: AccountQrPairingViewProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

  if (pairing.phase === 'claimed') {
    return (
      <Text
        testID={`${testIDPrefix}-claimed`}
        accessibilityLiveRegion="polite"
        style={[theme.typography.title, styles.centerText, { color: theme.colors.successColor }]}
      >
        {i18n.t('account.qrClaimSuccess')}
      </Text>
    );
  }

  if (pairing.phase === 'expired') {
    return (
      <View style={styles.qrBlock}>
        <Text
          testID={`${testIDPrefix}-expired`}
          style={[theme.typography.body, styles.centerText, { color: theme.colors.liveColor }]}
        >
          {i18n.t('account.qrExpired')}
        </Text>
        <CtaButton
          testID={`${testIDPrefix}-regenerate-btn`}
          variant="secondary"
          label={i18n.t('account.qrGenerateAction')}
          onPress={pairing.regenerate}
        />
      </View>
    );
  }

  if (pairing.phase === 'error') {
    return (
      <View style={styles.qrBlock}>
        <Text
          testID={`${testIDPrefix}-error`}
          style={[theme.typography.body, styles.centerText, { color: theme.colors.liveColor }]}
        >
          {i18n.t('account.errorGeneric')}
        </Text>
        <CtaButton
          testID={`${testIDPrefix}-retry-btn`}
          variant="secondary"
          label={i18n.t('account.qrGenerateAction')}
          onPress={pairing.regenerate}
        />
      </View>
    );
  }

  if (pairing.phase === 'loading' || pairing.session === null) {
    return (
      <Text
        testID={`${testIDPrefix}-loading`}
        style={[theme.typography.caption, styles.centerText, { color: theme.colors.textSecondary }]}
      >
        {i18n.t('account.syncingStatus')}
      </Text>
    );
  }

  return (
    <View style={styles.qrBlock}>
      <QrCodeView
        value={pairing.session.qrUri}
        size={size}
        testID={`${testIDPrefix}-code`}
        accessibilityLabel={i18n.t('account.qrTitle')}
      />
      <Text
        testID={`${testIDPrefix}-short-code`}
        selectable
        style={[
          theme.typography.title,
          TABULAR_NUMS_STYLE,
          { color: theme.colors.textPrimary, fontFamily: monoFont, letterSpacing: 2 },
        ]}
      >
        {pairing.session.code}
      </Text>
      <Text
        style={[theme.typography.caption, styles.centerText, { color: theme.colors.textSecondary }]}
      >
        {i18n.t('account.qrBody')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
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
  recoveryBox: {
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  codeBox: {
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  qrBlock: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 4,
  },
  centerText: { textAlign: 'center' },
});
