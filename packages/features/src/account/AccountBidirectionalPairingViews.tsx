import type { MessageId } from '@elv/i18n';
import { CtaButton, TABULAR_NUMS_STYLE, useI18n, useTheme } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { BidirectionalPairingSnapshot } from '../ports/wave-f9-ports';

/** Returns whether a bidirectional pairing session requires the 4-digit SAS confirmation card. */
export function shouldShowSasConfirmCard(session: BidirectionalPairingSnapshot | null): boolean {
  if (session === null || session.sas === null) return false;
  const status: string = session.status;
  return (
    status === 'awaiting_sas' ||
    status === 'responder_joined' ||
    status === 'responder_transferred' ||
    (status === 'approved' && session.role === 'responder')
  );
}

/** Returns whether a bidirectional pairing session should render the waiting-for-peer card. */
export function shouldShowWaitingCard(session: BidirectionalPairingSnapshot | null): boolean {
  if (session === null || shouldShowSasConfirmCard(session)) return false;
  const status: string = session.status;
  return (
    status === 'waiting_approval' ||
    status === 'approved' ||
    status === 'awaiting_sas' ||
    status === 'responder_transferred'
  );
}

/** Props of {@link BidirectionalPairingTerminalView}. */
export interface BidirectionalPairingTerminalViewProps {
  readonly session: BidirectionalPairingSnapshot;
  readonly isTv: boolean;
  readonly onRegenerate: () => void;
}

/** Renders terminal / special-outcome pairing views (`same_account`, `neither_signed_in`, completed, expired/locked/rejected). */
export function BidirectionalPairingTerminalView({
  session,
  isTv,
  onRegenerate,
}: BidirectionalPairingTerminalViewProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();

  if (session.direction === 'same_account') {
    const email = session.localMaskedEmail ?? session.peerMaskedEmail ?? '';
    return (
      <View testID="pair-case-same-account" style={styles.block}>
        <Text style={[theme.typography.title, { color: theme.colors.successColor }]}>
          {i18n.t('pair.caseSameAccountTitle')}
        </Text>
        <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
          {i18n.t('pair.caseSameAccountBody', { email })}
        </Text>
      </View>
    );
  }

  if (session.direction === 'neither_signed_in') {
    return (
      <View testID="pair-case-neither" style={styles.block}>
        <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
          {i18n.t('pair.caseNeitherTitle')}
        </Text>
        <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
          {i18n.t('pair.caseNeitherBody')}
        </Text>
        <CtaButton
          testID="pair-regenerate-btn"
          variant="secondary"
          label={i18n.t('account.qrGenerateAction')}
          hasTVPreferredFocus={isTv}
          onPress={onRegenerate}
        />
      </View>
    );
  }

  if (session.status === 'completed') {
    return (
      <View testID="pair-completed" style={styles.block}>
        <Text
          accessibilityLiveRegion="polite"
          style={[theme.typography.title, { color: theme.colors.successColor }]}
        >
          {i18n.t('pair.success')}
        </Text>
      </View>
    );
  }

  if (
    session.status === 'expired' ||
    session.status === 'locked' ||
    session.status === 'rejected'
  ) {
    const statusTestId =
      session.status === 'expired'
        ? 'pair-expired'
        : session.status === 'locked'
          ? 'pair-locked'
          : 'pair-rejected';
    const messageKey: MessageId =
      session.status === 'expired'
        ? 'pair.errorExpired'
        : session.status === 'locked'
          ? 'pair.errorLocked'
          : 'pair.errorRejected';
    return (
      <View testID={statusTestId} style={styles.block}>
        <Text
          accessibilityLiveRegion="polite"
          style={[theme.typography.body, { color: theme.colors.liveColor }]}
        >
          {i18n.t(messageKey)}
        </Text>
        <CtaButton
          testID="pair-regenerate-btn"
          variant="secondary"
          label={i18n.t('account.qrGenerateAction')}
          hasTVPreferredFocus={isTv}
          onPress={onRegenerate}
        />
      </View>
    );
  }

  return null;
}

/** Props of {@link BidirectionalPairingSasCard}. */
export interface BidirectionalPairingSasCardProps {
  readonly session: BidirectionalPairingSnapshot;
  readonly isWaiting: boolean;
  readonly isTv: boolean;
  readonly busy: boolean;
  readonly monoFont: string;
  readonly errorKey: MessageId | null;
  readonly onConfirm: (chosenDirection?: 'host_to_responder' | 'responder_to_host') => void;
  readonly onCancel: () => void;
}

/** Renders the 4-digit SAS verification card, `different_accounts` dual-choice CTA, or waiting-approval card. */
export function BidirectionalPairingSasCard({
  session,
  isWaiting,
  isTv,
  busy,
  monoFont,
  errorKey,
  onConfirm,
  onCancel,
}: BidirectionalPairingSasCardProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const isDifferent = session.direction === 'different_accounts';
  const isLocalSender =
    (session.role === 'host' && session.direction === 'host_to_responder') ||
    (session.role === 'responder' && session.direction === 'responder_to_host');
  const transferDir: 'host_to_responder' | 'responder_to_host' | undefined =
    session.direction === 'host_to_responder' || session.direction === 'responder_to_host'
      ? session.direction
      : undefined;

  return (
    <View
      testID="pair-sas-card"
      style={[
        styles.sasCard,
        {
          backgroundColor: theme.colors.bgCard,
          borderColor: theme.colors.accent,
          borderRadius: theme.radius.card,
        },
      ]}
    >
      <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>
        {isDifferent ? i18n.t('pair.caseDifferentTitle') : i18n.t('pair.sasTitle')}
      </Text>
      <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
        {isDifferent ? i18n.t('pair.caseDifferentBody') : i18n.t('pair.sasBody')}
      </Text>

      {session.sas !== null ? (
        <View
          style={[
            styles.sasCodeBox,
            {
              backgroundColor: theme.colors.bgCanvas,
              borderColor: theme.colors.surfaceBorder,
              borderRadius: theme.radius.button,
            },
          ]}
        >
          <Text
            testID="pair-sas-code"
            selectable
            style={[
              theme.typography.h1,
              TABULAR_NUMS_STYLE,
              styles.sasCodeText,
              { color: theme.colors.textPrimary, fontFamily: monoFont },
            ]}
          >
            {session.sas}
          </Text>
        </View>
      ) : null}

      {!isDifferent && transferDir !== undefined ? (
        <Text style={[theme.typography.body, { color: theme.colors.textPrimary }]}>
          {isLocalSender
            ? i18n.t('pair.caseTransferToOther', { email: session.localMaskedEmail ?? '' })
            : i18n.t('pair.caseReceiveFromOther', { email: session.peerMaskedEmail ?? '' })}
        </Text>
      ) : null}

      {errorKey !== null ? (
        <Text
          testID="pair-error"
          accessibilityLiveRegion="polite"
          style={[theme.typography.caption, { color: theme.colors.liveColor }]}
        >
          {i18n.t(errorKey)}
        </Text>
      ) : null}

      {isWaiting ? (
        <View style={styles.block}>
          <Text
            testID="pair-waiting-approval"
            accessibilityLiveRegion="polite"
            style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
          >
            {i18n.t('pair.waitingApproval')}
          </Text>
          <CtaButton
            testID="pair-sas-cancel"
            variant="secondary"
            label={i18n.t('pair.sasCancel')}
            hasTVPreferredFocus={isTv}
            disabled={busy}
            onPress={onCancel}
          />
        </View>
      ) : isDifferent ? (
        <View style={styles.block}>
          <CtaButton
            testID="pair-choose-this"
            variant="primary"
            label={i18n.t('pair.useThisAccount', { email: session.localMaskedEmail ?? '' })}
            hasTVPreferredFocus={isTv}
            disabled={busy}
            onPress={() =>
              onConfirm(session.role === 'host' ? 'host_to_responder' : 'responder_to_host')
            }
          />
          <CtaButton
            testID="pair-choose-other"
            variant="secondary"
            label={i18n.t('pair.useOtherAccount', { email: session.peerMaskedEmail ?? '' })}
            disabled={busy}
            onPress={() =>
              onConfirm(session.role === 'host' ? 'responder_to_host' : 'host_to_responder')
            }
          />
          <CtaButton
            testID="pair-sas-cancel"
            variant="ghost"
            label={i18n.t('pair.sasCancel')}
            disabled={busy}
            onPress={onCancel}
          />
        </View>
      ) : (
        <View style={styles.actionsRow}>
          <CtaButton
            testID="pair-sas-confirm"
            variant="primary"
            label={i18n.t('pair.sasConfirm')}
            hasTVPreferredFocus={isTv}
            disabled={busy}
            onPress={() => onConfirm(transferDir)}
          />
          <CtaButton
            testID="pair-sas-cancel"
            variant="secondary"
            label={i18n.t('pair.sasCancel')}
            disabled={busy}
            onPress={onCancel}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 12 },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  sasCard: { borderWidth: 1, padding: 16, gap: 12 },
  sasCodeBox: { borderWidth: 1, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center' },
  sasCodeText: { letterSpacing: 6, textAlign: 'center' },
});
