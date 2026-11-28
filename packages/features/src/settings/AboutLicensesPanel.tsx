import { CtaButton, Surface, useI18n, useTheme, useViewport } from '@elv/ui-kit';
import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DesktopUpdaterPort, DesktopUpdateState } from '../ports/updater-port';

/** Props of {@link AboutLicensesPanel}. */
export interface AboutLicensesPanelProps {
  /** Optional store-gated desktop auto-updater port (omitted on TV, mobile, and Store builds). */
  readonly updater?: DesktopUpdaterPort;
  /** Embedded third-party notices component rendered below the About ELV IPTV summary card. */
  readonly children?: ReactNode;
}

/**
 * Cinema Quietude About & Licenses settings section: compact summary card, optional store-gated
 * desktop Software Updates card (hidden when `updater` is absent or `'unsupported'`), and the
 * embedded offline Third-Party Notices browser (`flex: 1`).
 */
export function AboutLicensesPanel({ updater, children }: AboutLicensesPanelProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const compactHeight = viewport.height <= 460;

  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [installing, setInstalling] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (updater === undefined) {
      setUpdateState(null);
      setInstalling(false);
      return;
    }
    let cancelled = false;
    const unsubscribe = updater.subscribe((next) => {
      if (!cancelled && mountedRef.current) {
        setUpdateState(next);
        if (next.status !== 'downloaded') setInstalling(false);
      }
    });
    void updater
      .getState()
      .then((initial) => {
        if (!cancelled && mountedRef.current) setUpdateState(initial);
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) setUpdateState(null);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [updater]);

  const handleCheck = useCallback(() => {
    if (!updater) return;
    void updater
      .checkForUpdates()
      .then((next) => {
        if (mountedRef.current) setUpdateState(next);
      })
      .catch(() => undefined);
  }, [updater]);

  const handleDownload = useCallback(() => {
    if (!updater) return;
    void updater
      .downloadUpdate()
      .then((next) => {
        if (mountedRef.current) setUpdateState(next);
      })
      .catch(() => undefined);
  }, [updater]);

  const handleInstall = useCallback(() => {
    if (!updater || installing) return;
    setInstalling(true);
    void updater
      .installUpdate()
      .catch(() => undefined)
      .finally(() => {
        if (mountedRef.current) setInstalling(false);
      });
  }, [installing, updater]);

  const handleOpenReleasePage = useCallback(() => {
    if (!updater) return;
    void updater.openReleasePage().catch(() => undefined);
  }, [updater]);

  const showUpdater =
    updater !== undefined && updateState !== null && updateState.status !== 'unsupported';

  const clampedPercent =
    updateState?.downloadPercent !== undefined && Number.isFinite(updateState.downloadPercent)
      ? Math.max(0, Math.min(100, Math.round(updateState.downloadPercent)))
      : 0;

  let statusCaption: string | null = null;
  if (showUpdater && updateState !== null) {
    switch (updateState.status) {
      case 'checking':
        statusCaption = i18n.t('settings.updates.checking');
        break;
      case 'up-to-date':
        statusCaption = i18n.t('settings.updates.upToDate');
        break;
      case 'available':
        statusCaption = i18n.t('settings.updates.available', {
          version: updateState.availableVersion ?? updateState.currentVersion,
        });
        break;
      case 'downloading':
        statusCaption = i18n.t('settings.updates.downloading', { percent: clampedPercent });
        break;
      case 'downloaded':
        statusCaption = installing
          ? i18n.t('settings.updates.installing')
          : i18n.t('settings.updates.downloaded', {
              version: updateState.availableVersion ?? updateState.currentVersion,
            });
        break;
      case 'error':
        statusCaption =
          updateState.errorCode === 'checksum_mismatch'
            ? i18n.t('settings.updates.errorChecksum')
            : i18n.t('settings.updates.error');
        break;
      case 'idle':
        statusCaption = null;
        break;
    }
  }

  const showReleaseNotes =
    showUpdater &&
    updateState !== null &&
    (updateState.status === 'available' ||
      updateState.status === 'downloading' ||
      updateState.status === 'downloaded') &&
    typeof updateState.releaseNotes === 'string' &&
    updateState.releaseNotes.trim().length > 0;

  return (
    <View
      testID="settings-panel-licenses"
      style={[styles.root, { gap: compactHeight ? theme.spacing.xs : theme.spacing.sm }]}
    >
      <Surface
        testID="settings-about-card"
        tone="surface"
        bordered
        rounded="modal"
        style={styles.aboutCard}
      >
        <View style={styles.headerRow}>
          <Text
            numberOfLines={1}
            style={[theme.typography.title, styles.title, { color: theme.colors.textPrimary }]}
          >
            {i18n.t('settings.about.title')}
          </Text>
        </View>
        <Text
          numberOfLines={compactHeight ? 2 : undefined}
          style={[
            theme.typography.caption,
            styles.statement,
            { color: theme.colors.textSecondary },
          ]}
        >
          {i18n.t('settings.about.statement')}
        </Text>
        <Text
          testID="settings-tmdb-attribution"
          style={[theme.typography.caption, styles.statement, { color: theme.colors.textMuted }]}
        >
          {i18n.t('settings.about.tmdbAttribution')}
        </Text>
      </Surface>

      {showUpdater && updateState !== null ? (
        <Surface
          testID="settings-updater-card"
          tone="surface"
          bordered
          rounded="modal"
          style={styles.updaterCard}
        >
          <View style={styles.headerRow}>
            <Text
              numberOfLines={1}
              style={[theme.typography.title, styles.title, { color: theme.colors.textPrimary }]}
            >
              {i18n.t('settings.updates.title')}
            </Text>
            <Text
              testID="settings-updater-version"
              numberOfLines={1}
              style={[
                theme.typography.caption,
                styles.tabularText,
                { color: theme.colors.textSecondary },
              ]}
            >
              {i18n.t('settings.updates.currentVersion', { version: updateState.currentVersion })}
            </Text>
          </View>

          <View style={styles.updaterBodyRow}>
            <View style={styles.updaterMeta}>
              {statusCaption !== null ? (
                <Text
                  testID="settings-updater-status"
                  style={[
                    theme.typography.caption,
                    styles.tabularText,
                    {
                      color:
                        updateState.status === 'error'
                          ? theme.colors.dangerFg
                          : theme.colors.textSecondary,
                    },
                  ]}
                >
                  {statusCaption}
                </Text>
              ) : null}

              {updateState.status === 'downloading' ? (
                <View
                  testID="settings-updater-progress"
                  accessibilityRole="progressbar"
                  accessibilityValue={{ min: 0, max: 100, now: clampedPercent }}
                  style={[styles.progressTrack, { backgroundColor: theme.colors.surfaceBorder }]}
                >
                  <View
                    style={[
                      styles.progressFill,
                      { backgroundColor: theme.colors.accent, width: `${clampedPercent}%` },
                    ]}
                  />
                </View>
              ) : null}
            </View>

            <View style={styles.updaterActions}>
              {updateState.status === 'idle' ||
              updateState.status === 'up-to-date' ||
              updateState.status === 'checking' ||
              updateState.status === 'error' ? (
                <CtaButton
                  testID="settings-updater-check-btn"
                  variant="secondary"
                  label={
                    updateState.status === 'checking'
                      ? i18n.t('settings.updates.checking')
                      : i18n.t('settings.updates.check')
                  }
                  disabled={updateState.status === 'checking'}
                  onPress={handleCheck}
                />
              ) : null}

              {updateState.status === 'error' && updateState.manualDownloadUrl !== undefined ? (
                <CtaButton
                  testID="settings-updater-open-release-btn"
                  variant="ghost"
                  label={i18n.t('settings.updates.openReleasePage')}
                  onPress={handleOpenReleasePage}
                />
              ) : null}

              {updateState.status === 'available' ? (
                updateState.manualDownloadUrl !== undefined ? (
                  <CtaButton
                    testID="settings-updater-open-release-btn"
                    variant="primary"
                    label={i18n.t('settings.updates.openReleasePage')}
                    onPress={handleOpenReleasePage}
                  />
                ) : (
                  <CtaButton
                    testID="settings-updater-download-btn"
                    variant="primary"
                    label={i18n.t('settings.updates.download')}
                    onPress={handleDownload}
                  />
                )
              ) : null}

              {updateState.status === 'downloaded' ? (
                <CtaButton
                  testID="settings-updater-install-btn"
                  variant="primary"
                  label={
                    installing
                      ? i18n.t('settings.updates.installing')
                      : i18n.t('settings.updates.restartInstall')
                  }
                  disabled={installing}
                  onPress={handleInstall}
                />
              ) : null}
            </View>
          </View>

          {showReleaseNotes ? (
            <View style={[styles.notesBox, { borderTopColor: theme.colors.surfaceBorder }]}>
              <Text style={[theme.typography.caption, { color: theme.colors.textMuted }]}>
                {i18n.t('settings.updates.releaseNotes')}
              </Text>
              <Text
                testID="settings-updater-release-notes"
                numberOfLines={compactHeight ? 3 : 6}
                style={[
                  theme.typography.caption,
                  styles.statement,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {updateState.releaseNotes}
              </Text>
            </View>
          ) : null}
        </Surface>
      ) : null}

      <View style={styles.noticesWrap}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
  },
  aboutCard: {
    padding: 12,
    gap: 6,
  },
  updaterCard: {
    padding: 12,
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  updaterBodyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  updaterMeta: {
    flex: 1,
    minWidth: 180,
    gap: 6,
  },
  updaterActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    maxWidth: 320,
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  notesBox: {
    paddingTop: 8,
    borderTopWidth: 1,
    gap: 4,
  },
  title: {
    fontWeight: '700',
  },
  tabularText: {
    fontVariant: ['tabular-nums'],
  },
  statement: {
    maxWidth: 680,
  },
  noticesWrap: {
    flex: 1,
    minHeight: 0,
  },
});
