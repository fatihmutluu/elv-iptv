import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  runSecurityGate,
  type SecurityCheckStatus,
  type SecurityGateOptions,
  type SecurityGateReport,
  systemSecurityDeps,
} from './security-gate.ts';

/** Usage line of `pnpm gate security`. */
export const SECURITY_USAGE =
  'usage: pnpm gate security [--ci] [--out file] [--skip-audit] [--tv] [--artifact path ...] [--android-manifest path ...] [--apple-plist path ...] [--gradle-deps path ...]';

/** Parsed command-line options of `pnpm gate security`. */
export interface SecurityCli {
  ci?: boolean;
  out?: string;
  'skip-audit'?: boolean;
  tv?: boolean;
  artifact?: string[];
  'android-manifest'?: string[];
  'apple-plist'?: string[];
  'gradle-deps'?: string[];
}

/** Injectable I/O hooks for CLI tests. */
export interface SecurityCliIo {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  runGate?: (opts: SecurityGateOptions) => Promise<SecurityGateReport>;
}

const DEFAULT_CI_OUT = 'gate-artifacts/gate-security.json';

function statusTag(status: SecurityCheckStatus): string {
  if (status === 'fail') return 'FAIL';
  return status;
}

function escapeGithubAnnotation(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/** Runs `pnpm gate security`, writes an optional JSON report, and returns the exit code. */
export async function securityMain(
  values: SecurityCli,
  root: string,
  io: SecurityCliIo = {},
): Promise<number> {
  const stdout = io.stdout ?? ((s: string) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s: string) => process.stderr.write(s));
  const ci = values.ci === true;
  const runner =
    io.runGate ?? ((opts: SecurityGateOptions) => runSecurityGate(opts, systemSecurityDeps(root)));

  let report: SecurityGateReport;
  try {
    report = await runner({
      root,
      ci,
      ...(values['skip-audit'] === true ? { skipAudit: true } : {}),
      ...(values.tv === true ? { tv: true } : {}),
      ...(values.artifact === undefined ? {} : { artifacts: values.artifact }),
      ...(values['android-manifest'] === undefined
        ? {}
        : { androidManifests: values['android-manifest'] }),
      ...(values['apple-plist'] === undefined ? {} : { applePlists: values['apple-plist'] }),
      ...(values['gradle-deps'] === undefined ? {} : { gradleDeps: values['gradle-deps'] }),
    });
  } catch (error) {
    stderr(`gate security: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const rawOut = values.out ?? (ci ? DEFAULT_CI_OUT : undefined);
  let outPath: string | undefined;
  if (rawOut !== undefined) {
    outPath = resolve(root, rawOut);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`  [${statusTag(check.status)}] ${check.key}: ${check.summary}`);
    if (check.status === 'fail' || check.status === 'warn') {
      const kind = check.status === 'fail' ? 'error' : 'warning';
      for (const detail of check.details) {
        lines.push(
          ci
            ? `::${kind}::gate security (${check.key}): ${escapeGithubAnnotation(detail)}`
            : `    - ${detail}`,
        );
      }
    }
  }
  const suffix = outPath === undefined ? '' : ` (details in ${outPath})`;
  lines.push(`gate security: ${report.ok ? 'passed' : 'FAILED'}${suffix}`);
  stdout(`${lines.join('\n')}\n`);
  return report.ok ? 0 : 1;
}
