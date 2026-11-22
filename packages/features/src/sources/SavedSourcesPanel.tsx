import type { SourceRow } from '@elv/data';
import type { AppI18n } from '@elv/i18n';
import {
  hexToRgba,
  MicroPill,
  type MicroPillTone,
  Surface,
  TABULAR_NUMS_STYLE,
  useTheme,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Text, View } from 'react-native';
import { resolveSourceAccountWarning } from './account-warning';
import { ActionButton, SourceAccountWarningPill } from './SourcesScreenParts';
import { sourcesStyles } from './sources-styles';
import {
  phaseMessageId,
  type SourceRuntimeStatus,
  type SourcesController,
} from './useSourcesController';
import type { ControlLayoutRecorder } from './useTvSourcesNavigation';

function formatCompactSyncAge(timestampMs: number, nowMs: number): string {
  const diffMin = Math.max(0, Math.floor((nowMs - timestampMs) / 60_000));
  if (diffMin < 1) return '<1m';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

function resolveLastSyncedText(source: SourceRow, i18n: AppI18n, nowMs: number): string {
  const catalogAt =
    typeof source.lastCatalogSyncAt === 'number' && Number.isFinite(source.lastCatalogSyncAt)
      ? source.lastCatalogSyncAt
      : null;
  const guideAt =
    typeof source.lastGuideSyncAt === 'number' && Number.isFinite(source.lastGuideSyncAt)
      ? source.lastGuideSyncAt
      : null;
  const latest =
    catalogAt !== null && guideAt !== null ? Math.max(catalogAt, guideAt) : (catalogAt ?? guideAt);
  if (latest === null) return i18n.t('sources.neverSynced');
  return i18n.t('sources.lastSynced', { time: formatCompactSyncAge(latest, nowMs) });
}

function renderSourceStatusText(
  source: SourceRow,
  runtime: SourceRuntimeStatus | undefined,
  i18n: AppI18n,
  progressPct: number,
): string {
  if (runtime?.kind === 'importing') {
    const phase =
      runtime.progress === null
        ? i18n.t('sources.phase.categories')
        : i18n.t(phaseMessageId(runtime.progress.phase));
    return i18n.t('sources.status.importingPercent', {
      phase,
      done: runtime.progress?.done ?? 0,
      percent: progressPct,
    });
  }
  if (runtime?.kind === 'ready') {
    return i18n.t('sources.status.readyCounts', {
      live: runtime.summary.counts.live ?? 0,
      movies: runtime.summary.counts.movies ?? 0,
      series: runtime.summary.counts.series ?? 0,
    });
  }
  return source.needsImport ? i18n.t('sources.status.needsImport') : i18n.t('sources.status.ready');
}

function resolveStatusPill(
  source: SourceRow,
  runtime: SourceRuntimeStatus | undefined,
  i18n: AppI18n,
): { label: string; tone: MicroPillTone; dot?: boolean } {
  if (runtime?.kind === 'importing') {
    return { label: i18n.t('sources.action.adding'), tone: 'accent', dot: true };
  }
  if (runtime?.kind === 'error') {
    return { label: i18n.t('sources.status.needsImport'), tone: 'live' };
  }
  if (runtime?.kind === 'ready' || !source.needsImport) {
    return { label: i18n.t('sources.status.ready'), tone: 'success' };
  }
  return { label: i18n.t('sources.status.needsImport'), tone: 'accent' };
}

/**
 * Computes live monotonic import progress (`0..100`) preferring `@elv/data`'s `progress.percent`,
 * falling back to `Math.round((done / total) * 100)`, and finally a smooth monotonic asymptotic
 * curve from `done` so the bar never stalls at a static percentage (`#65`).
 */
export function importProgressPercent(runtime: SourceRuntimeStatus | undefined): number {
  if (runtime?.kind !== 'importing') return 0;
  const progress = runtime.progress;
  if (progress === null || progress === undefined) return 4;
  if (progress.percent !== undefined && Number.isFinite(progress.percent)) {
    return Math.min(100, Math.max(0, Math.round(progress.percent)));
  }
  const done = Math.max(0, Number.isFinite(progress.done) ? progress.done : 0);
  const total = progress.total;
  if (total !== undefined && Number.isFinite(total) && total > 0) {
    return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
  }
  return Math.min(95, Math.round(5 + 90 * (1 - 1 / (1 + done / 250))));
}

/** Saved IPTV sources list panel with status pills, accent progress bar, and error banners. */
export function SavedSourcesPanel({
  ctrl,
  i18n,
  twoColumn,
  tvFocusId,
  recordLayout,
  nowMs,
}: {
  ctrl: SourcesController;
  i18n: AppI18n;
  twoColumn: boolean;
  tvFocusId: string | undefined;
  recordLayout?: ControlLayoutRecorder;
  nowMs: number;
}): ReactElement {
  const theme = useTheme();
  return (
    <Surface
      tone="surface"
      bordered
      rounded="modal"
      style={[sourcesStyles.panel, twoColumn ? sourcesStyles.panelHalf : null]}
    >
      <Text style={[theme.typography.h2, { color: theme.colors.textPrimary }]}>
        {i18n.t('sources.section.saved')}
      </Text>
      {ctrl.sources.length === 0 ? (
        <View
          style={[
            sourcesStyles.emptyCard,
            { borderColor: theme.colors.surfaceBorder, borderRadius: theme.radius.card },
          ]}
        >
          <Text
            testID="sources-empty"
            style={[theme.typography.body, { color: theme.colors.textMuted }]}
          >
            {i18n.t('sources.emptyList')}
          </Text>
        </View>
      ) : (
        ctrl.sources.map((source) => {
          const runtime = ctrl.statusById[source.id];
          const isImporting = runtime?.kind === 'importing';
          const syncTestId = source.needsImport
            ? `source-import-${source.id}`
            : `source-refresh-${source.id}`;
          const syncLabel = source.needsImport
            ? i18n.t('sources.action.import')
            : i18n.t('sources.action.refresh');
          const kindLabel =
            source.kind === 'xtream' ? i18n.t('sources.kind.xtream') : i18n.t('sources.kind.m3u');
          const statusPill = resolveStatusPill(source, runtime, i18n);
          const accountWarning = resolveSourceAccountWarning(source.accountMeta, nowMs);
          const progressPct = importProgressPercent(runtime);

          return (
            <Surface
              key={source.id}
              testID={`source-row-${source.id}`}
              tone="card"
              bordered
              rounded="card"
              style={sourcesStyles.sourceRow}
            >
              <View style={sourcesStyles.sourceHeader}>
                <Text
                  numberOfLines={1}
                  style={[
                    theme.typography.title,
                    sourcesStyles.sourceName,
                    { color: theme.colors.textPrimary },
                  ]}
                >
                  {source.name}
                </Text>
                <MicroPill label={kindLabel} tone="neutral" />
              </View>
              <View style={sourcesStyles.statusRow}>
                <MicroPill label={statusPill.label} tone={statusPill.tone} dot={statusPill.dot} />
                <SourceAccountWarningPill
                  sourceId={source.id}
                  warning={accountWarning}
                  i18n={i18n}
                />
                <Text
                  testID={`source-status-${source.id}`}
                  style={[
                    theme.typography.caption,
                    TABULAR_NUMS_STYLE,
                    sourcesStyles.sourceStatus,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  {renderSourceStatusText(source, runtime, i18n, progressPct)}
                </Text>
                <Text
                  testID={`source-last-synced-${source.id}`}
                  style={[
                    theme.typography.caption,
                    TABULAR_NUMS_STYLE,
                    { color: theme.colors.textMuted },
                  ]}
                >
                  {resolveLastSyncedText(source, i18n, nowMs)}
                </Text>
              </View>
              {isImporting ? (
                <View
                  testID={`source-progress-bar-${source.id}`}
                  accessibilityRole="progressbar"
                  accessibilityValue={{ min: 0, max: 100, now: progressPct }}
                  style={[
                    sourcesStyles.progressTrack,
                    { backgroundColor: theme.colors.chipBg, borderRadius: theme.radius.pill },
                  ]}
                >
                  <View
                    style={[
                      sourcesStyles.progressFill,
                      {
                        backgroundColor: theme.colors.accent,
                        borderRadius: theme.radius.pill,
                        width: `${progressPct}%`,
                      },
                    ]}
                  />
                </View>
              ) : null}
              {runtime?.kind === 'error' ? (
                <View
                  style={[
                    sourcesStyles.errorBox,
                    {
                      backgroundColor: hexToRgba(theme.colors.liveColor, 0.14),
                      borderColor: theme.colors.liveColor,
                      borderRadius: theme.radius.card,
                    },
                  ]}
                >
                  <Text
                    testID={`source-error-${source.id}`}
                    style={[
                      theme.typography.caption,
                      sourcesStyles.errorText,
                      { color: theme.colors.textPrimary },
                    ]}
                  >
                    {i18n.t(runtime.failure.messageId)}
                  </Text>
                  {runtime.failure.httpStatus !== undefined ? (
                    <Text
                      testID={`source-http-status-${source.id}`}
                      style={[
                        theme.typography.caption,
                        TABULAR_NUMS_STYLE,
                        { color: theme.colors.textSecondary },
                      ]}
                    >
                      {i18n.t('source.error.httpStatus', { status: runtime.failure.httpStatus })}
                    </Text>
                  ) : null}
                  <Text
                    testID={`source-hint-${source.id}`}
                    style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
                  >
                    {i18n.t(runtime.failure.hintId)}
                  </Text>
                </View>
              ) : null}
              <View style={sourcesStyles.row}>
                {isImporting ? (
                  <ActionButton
                    focusId={`source-cancel-${source.id}`}
                    testID={`source-cancel-${source.id}`}
                    label={`${i18n.t('sources.action.cancel')} ${source.name}`}
                    tvFocused={tvFocusId === `source-cancel-${source.id}`}
                    onPress={() => ctrl.cancelImport(source.id)}
                    recordLayout={recordLayout}
                  />
                ) : (
                  <>
                    <ActionButton
                      focusId={`source-sync-${source.id}`}
                      testID={syncTestId}
                      label={`${syncLabel} ${source.name}`}
                      tvFocused={tvFocusId === `source-sync-${source.id}`}
                      onPress={() => void ctrl.runImport(source.id)}
                      recordLayout={recordLayout}
                    />
                    {!source.needsImport && ctrl.canRefreshGuide ? (
                      <ActionButton
                        focusId={`source-guide-${source.id}`}
                        testID={`source-refresh-guide-${source.id}`}
                        label={i18n.t('sources.refreshGuide')}
                        tvFocused={tvFocusId === `source-guide-${source.id}`}
                        onPress={() => void ctrl.runGuideRefresh(source.id)}
                        recordLayout={recordLayout}
                      />
                    ) : null}
                  </>
                )}
                <ActionButton
                  focusId={`source-remove-${source.id}`}
                  testID={`source-remove-${source.id}`}
                  label={`${i18n.t('sources.action.remove')} ${source.name}`}
                  danger
                  tvFocused={tvFocusId === `source-remove-${source.id}`}
                  onPress={() => void ctrl.remove(source.id)}
                  recordLayout={recordLayout}
                />
              </View>
            </Surface>
          );
        })
      )}
    </Surface>
  );
}
