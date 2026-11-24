/** One scripted D-pad action in the EPG proof gate sequence. */
export type EpgGateStepKey = 'down' | 'up' | 'right' | 'left';

/** Final metrics emitted by `EpgGateScreen` on `ELV_GATE {...}`. */
export interface EpgGateMetrics {
  readonly gate: 'epg';
  readonly channels: number;
  readonly days: number;
  readonly totalEstimatedProgrammes: number;
  readonly steps: number;
  readonly keyToHighlightP50Ms: number;
  readonly keyToHighlightP95Ms: number;
  readonly keyToHighlightMaxMs: number;
  readonly maxJsTaskMs: number;
  readonly framesOver16Ms: number;
  readonly focusContinuityOk: boolean;
  readonly passed: boolean;
}

const EPG_KEY_TO_HIGHLIGHT_BUDGET_MS = 100;

/**
 * Builds a deterministic D-pad script covering:
 * - vertical traversal across `>= 200` rows (or `channels - 1` when smaller) triggering virtualization/recycling,
 * - horizontal pan right & left across slots and day boundaries,
 * - overlap & gap-cell vertical jumps,
 * - vertical return up (clamped to actual rows descended so small channel counts never overflow above row 0).
 */
export function buildEpgGateScript(channels: number, moves: number): EpgGateStepKey[] {
  const safeMoves = Math.max(10, moves);
  const maxDown = Math.max(1, Math.min(channels - 1, Math.max(200, Math.floor(safeMoves * 0.7))));
  const steps: EpgGateStepKey[] = [];
  let downs = 0;

  // Phase 1: walk down through the first 8 rows with horizontal right/left probes on gap & staggered rows
  const probeRows = Math.min(8, maxDown);
  for (let i = 0; i < probeRows && steps.length < safeMoves; i++) {
    steps.push('down');
    downs++;
    if (i === 1 && steps.length + 3 <= safeMoves) {
      // Row 2 (index 2, reached after 2 downs) has intentional 15m gaps: pan right across gap and back
      steps.push('right', 'right', 'left');
    }
  }

  // Phase 2: bulk vertical scroll down across 200+ rows to exercise virtualization & row recycling
  const remainingDown = Math.max(0, maxDown - probeRows);
  for (let i = 0; i < remainingDown && steps.length < safeMoves - 12; i++) {
    steps.push('down');
    downs++;
  }

  // Phase 3: horizontal pan across time windows and back
  const panSteps: readonly EpgGateStepKey[] = ['right', 'right', 'right', 'right', 'left', 'left'];
  for (const key of panSteps) {
    if (steps.length < safeMoves) steps.push(key);
  }

  // Phase 4: vertical up steps to verify reverse recycling and overlap alignment (clamped to actual depth)
  let ups = 0;
  while (steps.length < safeMoves && ups < downs) {
    steps.push('up');
    ups++;
  }

  return steps;
}

function percentileMs(samples: readonly number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
  return Math.round((sorted[idx] ?? 0) * 100) / 100;
}

/** Summarizes recorded step timings into {@link EpgGateMetrics}. */
export function summarizeEpgGateMetrics(input: {
  readonly channels: number;
  readonly days: number;
  readonly totalEstimatedProgrammes: number;
  readonly keyLatenciesMs: readonly number[];
  readonly maxJsTaskMs: number;
  readonly framesOver16Ms: number;
  readonly focusContinuityOk: boolean;
}): EpgGateMetrics {
  const keyToHighlightP50Ms = percentileMs(input.keyLatenciesMs, 0.5);
  const keyToHighlightP95Ms = percentileMs(input.keyLatenciesMs, 0.95);
  const keyToHighlightMaxMs = percentileMs(input.keyLatenciesMs, 1);
  const maxJsTaskMs = Math.round(input.maxJsTaskMs * 100) / 100;
  const passed =
    input.focusContinuityOk &&
    input.keyLatenciesMs.length > 0 &&
    keyToHighlightP95Ms < EPG_KEY_TO_HIGHLIGHT_BUDGET_MS &&
    keyToHighlightMaxMs < EPG_KEY_TO_HIGHLIGHT_BUDGET_MS;
  return {
    gate: 'epg',
    channels: input.channels,
    days: input.days,
    totalEstimatedProgrammes: input.totalEstimatedProgrammes,
    steps: input.keyLatenciesMs.length,
    keyToHighlightP50Ms,
    keyToHighlightP95Ms,
    keyToHighlightMaxMs,
    maxJsTaskMs,
    framesOver16Ms: input.framesOver16Ms,
    focusContinuityOk: input.focusContinuityOk,
    passed,
  };
}

/** Formats the single-line `ELV_GATE {...}` log output read by `tools/src/gates/epg-gate.ts`. */
export function epgGateLine(metrics: EpgGateMetrics): string {
  return `ELV_GATE ${JSON.stringify(metrics)}`;
}
