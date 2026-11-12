/** Outcome of one check. `output` is shown only when `ok` is false. */
export interface CheckOutcome {
  ok: boolean;
  output: string;
}

/** A named project check. */
export interface Check {
  key: string;
  run: () => Promise<CheckOutcome>;
}

/** Result of one executed check. */
interface CheckResult extends CheckOutcome {
  key: string;
}

/** Aggregate result of {@link runChecks}. */
export interface CheckReport {
  results: CheckResult[];
  passed: number;
  failed: number;
}

/**
 * Runs the checks concurrently. `only` selects a single key; an unknown key is reported
 * as a failure. A check that throws counts as failed.
 */
export async function runChecks(
  checks: Check[],
  opts: { only?: string | undefined } = {},
): Promise<CheckReport> {
  let selected = checks;
  if (opts.only !== undefined) {
    selected = checks.filter((c) => c.key === opts.only);
    if (selected.length === 0) {
      const known = checks.map((c) => c.key).join(', ');
      const results = [
        { key: opts.only, ok: false, output: `unknown check "${opts.only}"; known: ${known}` },
      ];
      return { results, passed: 0, failed: 1 };
    }
  }
  const results = await Promise.all(
    selected.map(async (c): Promise<CheckResult> => {
      try {
        return { key: c.key, ...(await c.run()) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { key: c.key, ok: false, output: message };
      }
    }),
  );
  const failed = results.filter((r) => !r.ok).length;
  return { results, passed: results.length - failed, failed };
}

/** Renders failures followed by the final `check: N passed, M failed` line. */
export function formatReport(report: CheckReport): string {
  let text = '';
  for (const r of report.results) {
    if (r.ok) continue;
    text += `FAIL ${r.key}\n${r.output.trimEnd()}\n\n`;
  }
  return `${text}check: ${report.passed} passed, ${report.failed} failed\n`;
}
