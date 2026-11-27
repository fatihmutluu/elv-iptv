import type { CatalogService, ImportProgress, SourceRow } from '@elv/data';
import {
  CtaButton,
  TABULAR_NUMS_STYLE,
  useI18n,
  useTheme,
  useViewport,
  webTransition,
} from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SyncAccountPort } from '../ports/wave-f9-ports';
import { onboardingPhaseMessageId } from './onboarding-model';

/** Stage identifier of the 3-stage post-pair / post-signin hydration gate. */
type SyncingHydrationStage = 'syncing_account' | 'importing_sources' | 'preparing_app' | 'error';

const DEFAULT_STALL_TIMEOUT_MS = 45_000;

/** Props of {@link OnboardingSyncingStep}. */
export interface OnboardingSyncingStepProps {
  readonly catalog: CatalogService;
  readonly syncAccount?: SyncAccountPort | undefined;
  readonly onRefreshProfiles: () => Promise<void>;
  /** Optional prewarm hook executed in Stage 3 after catalog imports settle. */
  readonly onPrewarmReady?: ((sources: readonly SourceRow[]) => Promise<void>) | undefined;
  /** Optional inactivity stall timeout (ms) for Stage 2 source imports (defaults to 45s). */
  readonly importTimeoutMs?: number | undefined;
  /** Invoked once multi-stage sync, catalog hydration & prewarm settle (or user skips on failure). */
  readonly onSyncComplete: (sourcesCount: number) => void;
}

async function sourceNeedsHydration(catalog: CatalogService, source: SourceRow): Promise<boolean> {
  if (source.needsImport === true) return true;
  if (source.needsImport === false) return false;
  const counts = await Promise.all(
    (['live', 'movie', 'series'] as const).map(async (kind) => {
      const cats = await catalog.categories(source.id, kind).catch(() => []);
      return cats.length;
    }),
  );
  return counts.every((n) => n === 0);
}

async function defaultPrewarmCatalog(
  catalog: CatalogService,
  sources: readonly SourceRow[],
): Promise<void> {
  const ready = sources.slice(0, 2);
  await Promise.all([
    ...ready.flatMap((src) =>
      (['live', 'movie', 'series'] as const).map((kind) =>
        catalog.categories(src.id, kind).catch(() => []),
      ),
    ),
    catalog.listContinueWatching?.(12).catch(() => []) ?? Promise.resolve([]),
    catalog.listFavorites?.(24).catch(() => []) ?? Promise.resolve([]),
  ]);
}

function computeSourceProgressPct(
  sourceIndex: number,
  totalSources: number,
  progress: ImportProgress | null,
): number {
  const safeTotal = Math.max(1, totalSources);
  const sub =
    progress && progress.total !== undefined && progress.total > 0
      ? Math.min(1, Math.max(0, progress.done / progress.total))
      : 0.25;
  const fraction = (sourceIndex + sub) / safeTotal;
  return Math.min(88, Math.max(24, Math.round(24 + fraction * 62)));
}

/**
 * 3-stage post-sign-in / post-QR-transfer synchronization & catalog hydration gate (`#513`, `#16B`).
 * 1. Syncs account + profiles and enumerates restored sources (`0` sources -> advances to Add Source).
 * 2. Sequentially imports each un-imported source (`max_connections=1` safe) with live progress.
 * 3. Prewarms initial Home/category slices before entering the app (with non-blocking Retry & Continue).
 */
export function OnboardingSyncingStep({
  catalog,
  syncAccount,
  onRefreshProfiles,
  onPrewarmReady,
  importTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
  onSyncComplete,
}: OnboardingSyncingStepProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const viewport = useViewport();
  const isTv = viewport.formFactor === 'tv' || viewport.inputModality === 'tv';

  const [stage, setStage] = useState<SyncingHydrationStage>('syncing_account');
  const [progressPct, setProgressPct] = useState(14);
  const [activeSourceName, setActiveSourceName] = useState<string | null>(null);
  const [sourcePosition, setSourcePosition] = useState<{
    readonly index: number;
    readonly total: number;
  } | null>(null);
  const [liveProgress, setLiveProgress] = useState<ImportProgress | null>(null);
  const [sourcesTotalCount, setSourcesTotalCount] = useState(0);

  const runSeqRef = useRef(0);
  const activeAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const callbacksRef = useRef({ onRefreshProfiles, onPrewarmReady, onSyncComplete });
  callbacksRef.current = { onRefreshProfiles, onPrewarmReady, onSyncComplete };

  const executePipeline = useCallback(
    async (skipAccountSync: boolean) => {
      const seq = ++runSeqRef.current;
      activeAbortRef.current?.abort();
      const isCurrent = (): boolean => mountedRef.current && runSeqRef.current === seq;

      setStage('syncing_account');
      setProgressPct(skipAccountSync ? 22 : 14);
      setActiveSourceName(null);
      setSourcePosition(null);
      setLiveProgress(null);

      if (!skipAccountSync) {
        try {
          await syncAccount?.syncNow();
        } catch {
          // Proceed with local sources if remote sync fails transiently.
        }
        await callbacksRef.current.onRefreshProfiles().catch(() => undefined);
      }
      if (!isCurrent()) return;

      const sources = await catalog.listSources().catch(() => [] as SourceRow[]);
      if (!isCurrent()) return;
      setSourcesTotalCount(sources.length);

      if (sources.length === 0) {
        setProgressPct(100);
        callbacksRef.current.onSyncComplete(0);
        return;
      }

      const toImport: SourceRow[] = [];
      for (const src of sources) {
        if (await sourceNeedsHydration(catalog, src)) {
          toImport.push(src);
        }
        if (!isCurrent()) return;
      }

      if (toImport.length > 0) {
        setStage('importing_sources');
        let anyFailed = false;

        for (let idx = 0; idx < toImport.length; idx += 1) {
          const src = toImport[idx];
          if (!src || !isCurrent()) break;

          setSourcePosition({ index: idx + 1, total: toImport.length });
          setActiveSourceName(src.name);
          setLiveProgress(null);
          setProgressPct(computeSourceProgressPct(idx, toImport.length, null));

          const controller = new AbortController();
          activeAbortRef.current = controller;
          let timedOut = false;
          let stallTimer: ReturnType<typeof setTimeout> | null = null;

          const clearStallTimer = () => {
            if (stallTimer !== null) {
              clearTimeout(stallTimer);
              stallTimer = null;
            }
          };
          const armStallTimer = () => {
            clearStallTimer();
            stallTimer = setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, importTimeoutMs);
          };

          armStallTimer();
          try {
            const importPromise = Promise.resolve(
              catalog.importSource(src.id, {
                signal: controller.signal,
                onProgress: (prog) => {
                  if (!isCurrent() || controller.signal.aborted) return;
                  armStallTimer();
                  setLiveProgress(prog);
                  setProgressPct(computeSourceProgressPct(idx, toImport.length, prog));
                },
              }),
            );
            const abortPromise = new Promise<never>((_resolve, reject) => {
              controller.signal.addEventListener(
                'abort',
                () => reject(new Error(timedOut ? 'import_timeout' : 'aborted')),
                { once: true },
              );
            });
            const result = await Promise.race([importPromise, abortPromise]);
            if (result !== undefined && !result.ok) {
              anyFailed = true;
            }
          } catch {
            if (isCurrent()) anyFailed = true;
          } finally {
            clearStallTimer();
            if (activeAbortRef.current === controller) {
              activeAbortRef.current = null;
            }
          }

          if (!isCurrent()) return;
        }

        if (anyFailed) {
          setStage('error');
          return;
        }
      }

      setStage('preparing_app');
      setActiveSourceName(null);
      setSourcePosition(null);
      setProgressPct(92);

      const prewarmFn = callbacksRef.current.onPrewarmReady;
      if (prewarmFn !== undefined) {
        await prewarmFn(sources).catch(() => undefined);
      } else {
        await defaultPrewarmCatalog(catalog, sources).catch(() => undefined);
      }
      if (!isCurrent()) return;

      setProgressPct(100);
      callbacksRef.current.onSyncComplete(sources.length);
    },
    [catalog, importTimeoutMs, syncAccount],
  );

  useEffect(() => {
    mountedRef.current = true;
    void executePipeline(false);
    return () => {
      mountedRef.current = false;
      runSeqRef.current += 1;
      activeAbortRef.current?.abort();
      activeAbortRef.current = null;
    };
  }, [executePipeline]);

  const handleRetry = useCallback(() => {
    void executePipeline(true);
  }, [executePipeline]);

  const handleContinue = useCallback(() => {
    runSeqRef.current += 1;
    activeAbortRef.current?.abort();
    activeAbortRef.current = null;
    callbacksRef.current.onSyncComplete(sourcesTotalCount);
  }, [sourcesTotalCount]);

  if (stage === 'error') {
    return (
      <View testID="onboarding-syncing-step" style={styles.root}>
        <Text
          accessibilityRole="header"
          style={[theme.typography.h1, styles.center, { color: theme.colors.textPrimary }]}
        >
          {i18n.t('onboarding.syncing.failedTitle')}
        </Text>
        <Text style={[theme.typography.body, styles.center, { color: theme.colors.textSecondary }]}>
          {i18n.t('onboarding.syncing.failedBody')}
        </Text>
        <View style={styles.actionsRow}>
          <CtaButton
            testID="onboarding-sync-retry"
            variant="primary"
            label={i18n.t('onboarding.syncing.retryAction')}
            hasTVPreferredFocus={isTv}
            onPress={handleRetry}
          />
          <CtaButton
            testID="onboarding-sync-continue"
            variant="secondary"
            label={i18n.t('onboarding.syncing.continueAction')}
            onPress={handleContinue}
          />
        </View>
      </View>
    );
  }

  const stageLabel =
    stage === 'syncing_account'
      ? i18n.t('onboarding.syncing.stageAccount')
      : stage === 'importing_sources'
        ? i18n.t('onboarding.syncing.stageSources')
        : i18n.t('onboarding.syncing.stagePreparing');

  const stageIndex = stage === 'syncing_account' ? 1 : stage === 'importing_sources' ? 2 : 3;
  const phaseLabel =
    liveProgress !== null ? i18n.t(onboardingPhaseMessageId(liveProgress.phase)) : null;

  return (
    <View testID="onboarding-syncing-step" style={styles.root}>
      <Text
        accessibilityRole="header"
        style={[theme.typography.h1, styles.center, { color: theme.colors.textPrimary }]}
      >
        {i18n.t('onboarding.syncing.title')}
      </Text>
      <Text
        testID="onboarding-sync-stage-label"
        accessibilityLiveRegion="polite"
        style={[theme.typography.body, styles.center, { color: theme.colors.textSecondary }]}
      >
        {`${stageIndex}/3 · ${stageLabel}`}
      </Text>

      <View
        style={[
          styles.track,
          { backgroundColor: theme.colors.bgSurface, borderRadius: theme.radius.pill },
        ]}
      >
        <View
          testID="onboarding-sync-progress-fill"
          style={[
            styles.fill,
            webTransition(theme, 'width'),
            {
              width: `${progressPct}%`,
              backgroundColor: theme.colors.accent,
              borderRadius: theme.radius.pill,
            },
          ]}
        />
      </View>

      {stage === 'importing_sources' && activeSourceName !== null && sourcePosition !== null ? (
        <View style={styles.detailBlock}>
          <Text
            testID="onboarding-sync-source-status"
            style={[
              theme.typography.caption,
              TABULAR_NUMS_STYLE,
              styles.center,
              { color: theme.colors.textSecondary },
            ]}
          >
            {[
              i18n.t('onboarding.syncing.sourceCounter', {
                index: sourcePosition.index,
                total: sourcePosition.total,
                name: activeSourceName,
              }),
              liveProgress !== null && phaseLabel !== null
                ? `${phaseLabel} (${i18n.t('onboarding.syncing.itemsProgress', { count: liveProgress.done })})`
                : null,
            ]
              .filter((s) => s !== null)
              .join(' · ')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { width: '100%', paddingVertical: 32, alignItems: 'center', gap: 14 },
  center: { textAlign: 'center' },
  track: { width: '78%', maxWidth: 360, height: 6, overflow: 'hidden', marginTop: 6 },
  fill: { height: '100%' },
  detailBlock: { width: '100%', paddingHorizontal: 12 },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8 },
});
