import {
  CtaButton,
  Icon,
  useFormFactor,
  useI18n,
  useTheme,
  useViewport,
  webBackdropBlur,
} from '@elv/ui-kit';
import { type ComponentRef, type ReactElement, useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useDesktopDialogTrap } from './desktop-dialog-trap';

/** Pre-flight connection limit evaluation surfaced to {@link ConnectionLimitDialog} (`#87`). */
export interface ConnectionLimitCheckInfo {
  readonly ownActiveCount: number;
  readonly maxConnections: number;
  readonly providerActiveCons?: number;
  readonly canStopOwnStream: boolean;
}

/** Props of {@link ConnectionLimitDialog}. */
export interface ConnectionLimitDialogProps {
  readonly check: ConnectionLimitCheckInfo;
  readonly onStopOther?: () => void;
  readonly onCancel: () => void;
  readonly onContinueAnyway: () => void;
  /** Optional TV D-pad focus index override (`0..actions.length-1`). */
  readonly focusedActionIndex?: number;
  readonly testID?: string;
}

/**
 * Cinema Quietude v2 pre-flight connection-limit warning modal (`#87`).
 * Works on TV D-pad, touch, and desktop keyboard. States strictly what is known from in-app
 * active stream tracking and optional provider-reported `active_cons` — never guessing counts.
 */
export function ConnectionLimitDialog({
  check,
  onStopOther,
  onCancel,
  onContinueAnyway,
  focusedActionIndex,
  testID = 'connection-limit-dialog',
}: ConnectionLimitDialogProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const formFactor = useFormFactor();
  const viewport = useViewport();
  const isTv = formFactor === 'tv';
  const isWebDesktop = formFactor === 'desktop' && (Platform.OS as string) === 'web';
  const panelRef = useRef<ComponentRef<typeof View> | null>(null);

  useDesktopDialogTrap(panelRef, isWebDesktop, onCancel);

  const title = i18n.t('player.connectionLimit.title');
  const max = Math.max(1, Math.floor(check.maxConnections));

  const bodyLines: string[] = [];
  if (check.providerActiveCons !== undefined) {
    bodyLines.push(
      i18n.t('player.connectionLimit.providerReportedBody', {
        active: check.providerActiveCons,
        max,
      }),
    );
    if (check.ownActiveCount > 0) {
      bodyLines.push(i18n.t('player.connectionLimit.ownActiveBody', { max }));
    }
  } else if (check.ownActiveCount > 0) {
    bodyLines.push(i18n.t('player.connectionLimit.ownActiveBody', { max }));
  } else {
    bodyLines.push(i18n.t('player.connectionLimit.unknownBody', { max }));
  }

  const showStopOther = check.canStopOwnStream && onStopOther !== undefined;
  const dialogA11yProps = isWebDesktop
    ? ({
        role: 'dialog',
        'aria-modal': true,
        'aria-label': title,
      } as Record<string, unknown>)
    : undefined;

  const stopOtherLabel = i18n.t('player.connectionLimit.stopOther');
  const cancelLabel = i18n.t('player.connectionLimit.cancel');
  const continueLabel = i18n.t('player.connectionLimit.continueAnyway');

  const cancelIndex = showStopOther ? 1 : 0;
  const continueIndex = showStopOther ? 2 : 1;

  return (
    <View
      testID={testID}
      style={[
        styles.backdrop,
        {
          backgroundColor: theme.colors.overlayBackdrop,
          paddingHorizontal: 20 + viewport.overscan.x,
          paddingVertical: 20 + viewport.overscan.y,
        },
      ]}
    >
      <View
        ref={panelRef}
        testID="connection-limit-panel"
        {...dialogA11yProps}
        style={[
          styles.panel,
          isTv ? styles.panelTv : null,
          {
            backgroundColor: theme.colors.glassBg,
            borderColor: theme.colors.glassBorder,
            borderRadius: theme.radius.modal,
          },
          webBackdropBlur(20),
        ]}
      >
        <View style={styles.headerRow}>
          <Icon name="warning" size={20} color={theme.colors.liveColor} />
          <Text
            testID="connection-limit-title"
            style={[theme.typography.h2, styles.title, { color: theme.colors.textPrimary }]}
          >
            {title}
          </Text>
        </View>

        <Text
          testID="connection-limit-body"
          style={[theme.typography.body, styles.body, { color: theme.colors.textSecondary }]}
        >
          {bodyLines.join(' ')}
        </Text>

        <View style={[styles.actions, formFactor === 'phone' ? styles.actionsStacked : null]}>
          {showStopOther ? (
            <CtaButton
              testID="connection-limit-stop-other"
              variant="primary"
              label={stopOtherLabel}
              accessibilityLabel={stopOtherLabel}
              hasTVPreferredFocus={isTv && focusedActionIndex === undefined}
              focused={focusedActionIndex !== undefined ? focusedActionIndex === 0 : undefined}
              onPress={onStopOther}
              style={styles.actionButton}
            />
          ) : null}
          <CtaButton
            testID="connection-limit-cancel"
            variant={showStopOther ? 'secondary' : 'primary'}
            label={cancelLabel}
            accessibilityLabel={cancelLabel}
            hasTVPreferredFocus={isTv && !showStopOther && focusedActionIndex === undefined}
            focused={
              focusedActionIndex !== undefined ? focusedActionIndex === cancelIndex : undefined
            }
            onPress={onCancel}
            style={styles.actionButton}
          />
          <CtaButton
            testID="connection-limit-continue"
            variant="secondary"
            label={continueLabel}
            accessibilityLabel={continueLabel}
            focused={
              focusedActionIndex !== undefined ? focusedActionIndex === continueIndex : undefined
            }
            onPress={onContinueAnyway}
            style={styles.actionButton}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    zIndex: 40,
  },
  panel: {
    width: '100%',
    maxWidth: 480,
    borderWidth: 1,
    padding: 20,
    gap: 14,
  },
  panelTv: {
    maxWidth: 560,
    padding: 28,
    gap: 18,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    flex: 1,
  },
  body: {
    lineHeight: 21,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 10,
    paddingTop: 4,
  },
  actionsStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  actionButton: {
    minHeight: 40,
  },
});
