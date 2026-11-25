import { buildCrashReportMarkdown, MAX_CRASH_LOG_LINES } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import {
  CtaButton,
  TvFocusAnchor,
  useFormFactor,
  useI18n,
  useKeyInterpreter,
  useTheme,
  useViewport,
  webBackdropBlur,
  webCursorPointer,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { DiagnosticsPort } from '../ports/wave-f7b-ports';

/** Props of {@link CrashReportPreviewModal}. */
export interface CrashReportPreviewModalProps {
  readonly visible: boolean;
  readonly diagnostics: DiagnosticsPort;
  readonly errorCode: string;
  readonly errorMessage?: string;
  readonly stack?: string;
  readonly componentStack?: string;
  readonly includeLogs: boolean;
  readonly onToggleIncludeLogs?: (next: boolean) => void;
  readonly onClose: () => void;
}

type ModalActionId = 'toggleLogs' | 'copy' | 'export' | 'close';

/**
 * Cinema Quietude in-tree overlay (never RN `<Modal>` on TV) displaying a live double-redacted
 * Markdown diagnostic crash report with opt-in recent log attachment (`#226`).
 */
export function CrashReportPreviewModal({
  visible,
  diagnostics,
  errorCode,
  errorMessage,
  stack,
  componentStack,
  includeLogs,
  onToggleIncludeLogs,
  onClose,
}: CrashReportPreviewModalProps): ReactElement | null {
  const theme = useTheme();
  const i18n = useI18n();
  const formFactor = useFormFactor();
  const viewport = useViewport();
  const isTv = formFactor === 'tv' || viewport.inputModality === 'tv';

  const [localIncludeLogs, setLocalIncludeLogs] = useState(includeLogs);
  const [logLines, setLogLines] = useState<readonly string[]>([]);
  const [feedback, setFeedback] = useState<'copied' | 'exported' | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);

  useEffect(() => {
    if (visible) {
      setLocalIncludeLogs(includeLogs);
    }
  }, [includeLogs, visible]);

  useEffect(() => {
    if (!visible) {
      setFeedback(null);
      return;
    }
    setFocusedIndex(0);
    if (!localIncludeLogs) {
      setLogLines([]);
      return;
    }
    let cancelled = false;
    void diagnostics
      .readLogTail(MAX_CRASH_LOG_LINES)
      .then((lines) => {
        if (!cancelled) setLogLines(lines);
      })
      .catch(() => {
        if (!cancelled) setLogLines([]);
      });
    return () => {
      cancelled = true;
    };
  }, [diagnostics, localIncludeLogs, visible]);

  const markdown = useMemo(
    () =>
      buildCrashReportMarkdown({
        appVersion: diagnostics.appVersion,
        platform: diagnostics.platformLabel,
        ...(diagnostics.osVersion !== undefined ? { osVersion: diagnostics.osVersion } : {}),
        errorCode,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        ...(stack !== undefined ? { stack } : {}),
        ...(componentStack !== undefined ? { componentStack } : {}),
        includeLogs: localIncludeLogs,
        ...(localIncludeLogs ? { logLines } : {}),
      }),
    [
      componentStack,
      diagnostics.appVersion,
      diagnostics.osVersion,
      diagnostics.platformLabel,
      errorCode,
      errorMessage,
      localIncludeLogs,
      logLines,
      stack,
    ],
  );

  const handleToggleLogs = useCallback(() => {
    setLocalIncludeLogs((prev) => {
      const next = !prev;
      onToggleIncludeLogs?.(next);
      return next;
    });
  }, [onToggleIncludeLogs]);

  const handleCopy = useCallback(() => {
    if (!diagnostics.copyText) return;
    void diagnostics
      .copyText(markdown)
      .then((ok) => {
        if (ok) setFeedback('copied');
      })
      .catch(() => undefined);
  }, [diagnostics, markdown]);

  const handleExport = useCallback(() => {
    if (!diagnostics.exportMarkdown) return;
    void diagnostics
      .exportMarkdown(markdown)
      .then((ok) => {
        if (ok) setFeedback('exported');
      })
      .catch(() => undefined);
  }, [diagnostics, markdown]);

  const actions = useMemo<readonly ModalActionId[]>(() => {
    const list: ModalActionId[] = ['toggleLogs'];
    if (diagnostics.copyText !== undefined) list.push('copy');
    if (diagnostics.exportMarkdown !== undefined) list.push('export');
    list.push('close');
    return list;
  }, [diagnostics.copyText, diagnostics.exportMarkdown]);

  const navRef = useRef({
    visible,
    actions,
    focusedIndex,
    handleToggleLogs,
    handleCopy,
    handleExport,
    onClose,
  });
  navRef.current = {
    visible,
    actions,
    focusedIndex,
    handleToggleLogs,
    handleCopy,
    handleExport,
    onClose,
  };

  const handleKey = useCallback((event: KeyEvent): boolean => {
    const s = navRef.current;
    if (!s.visible) return false;
    if (event.kind === 'press' && event.key === 'back') {
      s.onClose();
      return true;
    }
    if (event.kind !== 'press' && event.kind !== 'repeat') return true;
    if (event.key === 'left' || event.key === 'up') {
      setFocusedIndex((prev) => (prev - 1 + s.actions.length) % s.actions.length);
      return true;
    }
    if (event.key === 'right' || event.key === 'down') {
      setFocusedIndex((prev) => (prev + 1) % s.actions.length);
      return true;
    }
    if (event.kind === 'press' && event.key === 'select') {
      const id = s.actions[s.focusedIndex];
      if (id === 'toggleLogs') s.handleToggleLogs();
      else if (id === 'copy') s.handleCopy();
      else if (id === 'export') s.handleExport();
      else if (id === 'close') s.onClose();
      return true;
    }
    return true;
  }, []);

  useKeyInterpreter(handleKey);

  if (!visible) return null;

  const focusedAction = actions[focusedIndex];
  const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

  return (
    <View
      testID="crash-report-preview-modal"
      style={[
        styles.backdrop,
        {
          backgroundColor: theme.colors.bgCanvas,
          paddingHorizontal: Math.max(theme.spacing.lg, viewport.overscan.x),
          paddingVertical: Math.max(theme.spacing.lg, viewport.overscan.y),
        },
      ]}
    >
      {isTv ? <TvFocusAnchor testID="crash-report-focus-anchor" hasTVPreferredFocus /> : null}
      <View
        style={[
          styles.panel,
          {
            backgroundColor: theme.colors.bgElevated,
            borderColor: theme.colors.surfaceBorder,
            borderRadius: theme.radius.modal,
            padding: theme.spacing.lg,
            gap: theme.spacing.md,
          },
          webBackdropBlur(16),
        ]}
      >
        <View style={{ gap: theme.spacing.xxs }}>
          <Text
            testID="crash-report-title"
            accessibilityRole="header"
            style={[theme.typography.h2, { color: theme.colors.textPrimary }]}
          >
            {i18n.t('crash.report.title')}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {i18n.t('crash.report.subtitle')}
          </Text>
        </View>

        <Pressable
          testID="crash-report-include-logs-toggle"
          accessibilityRole="switch"
          accessibilityLabel={i18n.t('crash.report.includeLogsToggle')}
          accessibilityState={{ checked: localIncludeLogs }}
          focusable={!isTv}
          onPress={handleToggleLogs}
          style={[
            styles.toggleRow,
            {
              backgroundColor: theme.colors.bgSurface,
              borderColor:
                isTv && focusedAction === 'toggleLogs'
                  ? theme.colors.focusRingColor
                  : theme.colors.surfaceBorder,
              borderWidth: isTv && focusedAction === 'toggleLogs' ? theme.focus.ringWidth : 1,
              borderRadius: theme.radius.button,
              paddingHorizontal: theme.spacing.md,
              paddingVertical: theme.spacing.sm,
            },
            !isTv ? webCursorPointer() : undefined,
          ]}
        >
          <Text style={[theme.typography.body, styles.flex1, { color: theme.colors.textPrimary }]}>
            {i18n.t('crash.report.includeLogsToggle')}
          </Text>
          <View
            style={[
              styles.switchTrack,
              {
                backgroundColor: localIncludeLogs
                  ? theme.colors.accent
                  : theme.colors.surfaceBorder,
                borderRadius: theme.radius.pill,
              },
            ]}
          >
            <View
              style={[
                styles.switchThumb,
                {
                  backgroundColor: theme.colors.ctaBg,
                  alignSelf: localIncludeLogs ? 'flex-end' : 'flex-start',
                },
              ]}
            />
          </View>
        </Pressable>

        <ScrollView
          testID="crash-report-markdown-scroll"
          focusable={!isTv}
          style={[
            styles.previewBox,
            {
              backgroundColor: theme.colors.bgCanvas,
              borderColor: theme.colors.surfaceBorder,
              borderRadius: theme.radius.card,
            },
          ]}
          contentContainerStyle={{ padding: theme.spacing.md }}
        >
          <Text
            testID="crash-report-markdown-text"
            selectable
            style={[
              theme.typography.caption,
              { color: theme.colors.textSecondary, fontFamily: monoFont },
            ]}
          >
            {markdown}
          </Text>
        </ScrollView>

        {feedback !== null ? (
          <Text
            testID="crash-report-feedback"
            accessibilityLiveRegion="polite"
            style={[theme.typography.caption, { color: theme.colors.successColor }]}
          >
            {i18n.t(feedback === 'copied' ? 'crash.report.copied' : 'crash.report.exported')}
          </Text>
        ) : null}

        <View style={[styles.actionsRow, { gap: theme.spacing.sm }]}>
          {diagnostics.copyText !== undefined ? (
            <CtaButton
              testID="crash-report-copy"
              variant="primary"
              label={i18n.t('crash.report.copy')}
              focused={isTv && focusedAction === 'copy'}
              focusable={!isTv}
              onPress={handleCopy}
            />
          ) : null}
          {diagnostics.exportMarkdown !== undefined ? (
            <CtaButton
              testID="crash-report-export"
              variant="secondary"
              label={i18n.t('crash.report.export')}
              focused={isTv && focusedAction === 'export'}
              focusable={!isTv}
              onPress={handleExport}
            />
          ) : null}
          <CtaButton
            testID="crash-report-close"
            variant="secondary"
            label={i18n.t('crash.report.close')}
            focused={isTv && focusedAction === 'close'}
            focusable={!isTv}
            onPress={onClose}
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
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 70,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    width: '100%',
    maxWidth: 680,
    maxHeight: '88%',
    borderWidth: 1,
  },
  toggleRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  flex1: { flex: 1 },
  switchTrack: {
    width: 42,
    height: 24,
    padding: 3,
    justifyContent: 'center',
  },
  switchThumb: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  previewBox: {
    maxHeight: 280,
    borderWidth: 1,
  },
  actionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
});
