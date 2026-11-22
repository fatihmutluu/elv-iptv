import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exec as runExec } from '../exec.ts';
import { verifyDirectory as verifyFfmpegDirectory } from '../ffmpeg-media3/fetch.ts';
import { verifyDirectory as verifyMpvDirectory } from '../mpv/fetch.ts';
import { realDeps as realMpvDeps } from '../mpv/real-deps.ts';
import { runReleaseHygiene } from '../release-hygiene.ts';
import { scanStaticSecurityInvariants } from './static-invariants.ts';

export { scanStaticSecurityInvariants };

/** Result status of a single security gate check. */
export type SecurityCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

interface SecurityCheckResult {
  readonly key: string;
  readonly status: SecurityCheckStatus;
  readonly summary: string;
  readonly details: string[];
}

/** Structured report emitted by {@link runSecurityGate}. */
export interface SecurityGateReport {
  readonly ok: boolean;
  readonly timestamp: string;
  readonly ci: boolean;
  readonly checks: SecurityCheckResult[];
}

/** Options for {@link runSecurityGate}. */
export interface SecurityGateOptions {
  readonly root: string;
  readonly ci?: boolean;
  readonly skipAudit?: boolean;
  readonly tv?: boolean;
  readonly artifacts?: readonly string[];
  readonly androidManifests?: readonly string[];
  readonly applePlists?: readonly string[];
  readonly gradleDeps?: readonly string[];
}

/** Injectable side effects for {@link runSecurityGate}. */
export interface SecurityGateDeps {
  readonly exec: (
    command: string,
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number },
  ) => Promise<{ ok: boolean; output: string }>;
  readonly hasBinary: (name: string) => boolean;
  readonly verifyMpvDir?: (dir: string) => Promise<void>;
  readonly verifyFfmpegMedia3Dir?: (dir: string) => void;
  readonly now?: () => string;
}

const OFFLINE_AUDIT_RE =
  /ERR_PNPM_AUDIT_NO_RESPONSE|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|ECONNRESET|fetch failed/i;
const SAFE_BINARY_NAME_RE = /^[A-Za-z0-9._-]+$/;

function makeCheck(
  key: string,
  status: SecurityCheckStatus,
  summary: string,
  details: string[] = [],
): SecurityCheckResult {
  return { key, status, summary, details };
}

function discoverHookTests(root: string): string[] {
  const found: string[] = [];
  for (const rel of [
    ['.claude', 'hooks'],
    ['.agents', 'hooks'],
  ]) {
    const dir = join(root, ...rel);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (/\.test\.[cm]?js$/.test(file)) found.push(join(dir, file));
    }
  }
  return found.sort();
}

const outputLines = (output: string): string[] =>
  output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');

function hasDirectoryContent(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function defaultHasBinary(name: string): boolean {
  const direct = spawnSync(name, ['version'], { stdio: 'ignore', windowsHide: true });
  if (direct.error === undefined) return direct.status === 0;
  if (process.platform === 'win32' && SAFE_BINARY_NAME_RE.test(name)) {
    const shimmed = spawnSync(`${name} version`, {
      stdio: 'ignore',
      windowsHide: true,
      shell: true,
    });
    return shimmed.error === undefined && shimmed.status === 0;
  }
  return false;
}

async function runLgplLicencesCheck(
  root: string,
  deps: SecurityGateDeps,
): Promise<SecurityCheckResult> {
  const verifyMpv =
    deps.verifyMpvDir ??
    (async (dir: string) => {
      await verifyMpvDirectory(
        dir.replaceAll('\\', '/'),
        realMpvDeps(() => {}, root.replaceAll('\\', '/')),
      );
    });
  const verifyFfmpeg = deps.verifyFfmpegMedia3Dir ?? verifyFfmpegDirectory;
  const checked: string[] = [];
  const errors: string[] = [];

  const mpvBase = join(root, 'apps', 'desktop', 'resources', 'mpv');
  if (existsSync(mpvBase) && statSync(mpvBase).isDirectory()) {
    for (const entry of readdirSync(mpvBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runtimeDir = join(mpvBase, entry.name);
      if (!hasDirectoryContent(runtimeDir)) continue;
      const label = `mpv/${entry.name}`;
      checked.push(label);
      try {
        await verifyMpv(runtimeDir);
      } catch (error) {
        errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  for (const rel of [
    ['modules', 'engine-media3', 'vendor', 'ffmpeg-media3'],
    ['modules', 'engine-media3', 'android', 'libs'],
  ]) {
    const dir = join(root, ...rel);
    if (!hasDirectoryContent(dir)) continue;
    const label = rel.join('/');
    checked.push(label);
    try {
      verifyFfmpeg(dir);
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (checked.length === 0) {
    return makeCheck(
      'lgpl-licences',
      'skip',
      'no local native runtimes installed (mpv / ffmpeg-media3)',
    );
  }
  return errors.length === 0
    ? makeCheck('lgpl-licences', 'pass', `verified LGPL licences (${checked.join(', ')})`)
    : makeCheck(
        'lgpl-licences',
        'fail',
        `${errors.length} LGPL licence verification failure(s)`,
        errors,
      );
}

/** Builds production {@link SecurityGateDeps} bound to the repository `root`. */
export function systemSecurityDeps(root: string): SecurityGateDeps {
  return {
    exec: (command, args, opts) =>
      runExec(command, args, {
        cwd: opts?.cwd ?? root,
        ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      }),
    hasBinary: defaultHasBinary,
  };
}

/**
 * Runs all pre-release and CI security gate checks and returns a structured {@link SecurityGateReport}.
 */
export async function runSecurityGate(
  options: SecurityGateOptions,
  deps: SecurityGateDeps,
): Promise<SecurityGateReport> {
  const ci = options.ci === true;
  const checks: SecurityCheckResult[] = [];

  const violations = scanStaticSecurityInvariants(options.root);
  checks.push(
    makeCheck(
      'static-invariants',
      violations.length === 0 ? 'pass' : 'fail',
      violations.length === 0
        ? 'all static security invariants passed'
        : `${violations.length} static security invariant violation(s)`,
      violations,
    ),
  );

  const rulesRes = await deps.exec('node', ['scripts/test-gitleaks-rules.mjs']);
  if (!rulesRes.ok) {
    checks.push(
      makeCheck(
        'gitleaks-rules',
        'fail',
        'gitleaks rule self-tests failed',
        outputLines(rulesRes.output),
      ),
    );
  } else if (/^SKIP/m.test(rulesRes.output)) {
    checks.push(
      makeCheck(
        'gitleaks-rules',
        ci ? 'fail' : 'warn',
        ci
          ? 'gitleaks is required in --ci (rules self-test was skipped)'
          : 'gitleaks is not on PATH; rules self-test skipped',
        outputLines(rulesRes.output),
      ),
    );
  } else {
    checks.push(makeCheck('gitleaks-rules', 'pass', 'gitleaks rule self-tests passed'));
  }

  if (!deps.hasBinary('gitleaks')) {
    checks.push(
      makeCheck(
        'gitleaks-git',
        ci ? 'fail' : 'warn',
        ci
          ? 'gitleaks binary not found on PATH (required in --ci)'
          : 'gitleaks binary not found on PATH; git history scan skipped',
        ['install gitleaks or add it to PATH to run git history secret scanning'],
      ),
    );
  } else {
    const gitRes = await deps.exec('gitleaks', [
      'git',
      '--config',
      '.gitleaks.toml',
      '--redact',
      '--no-banner',
    ]);
    checks.push(
      makeCheck(
        'gitleaks-git',
        gitRes.ok ? 'pass' : 'fail',
        gitRes.ok ? 'git history secret scan clean' : 'gitleaks detected potential secrets',
        gitRes.ok ? [] : outputLines(gitRes.output),
      ),
    );
  }

  const hookFiles = discoverHookTests(options.root);
  if (hookFiles.length === 0) {
    checks.push(makeCheck('agent-hooks', 'skip', 'no agent hook test files found'));
  } else {
    const hooksRes = await deps.exec('node', ['--test', ...hookFiles]);
    checks.push(
      makeCheck(
        'agent-hooks',
        hooksRes.ok ? 'pass' : 'fail',
        hooksRes.ok
          ? `agent hook tests passed (${hookFiles.length} file(s))`
          : 'agent hook tests failed',
        hooksRes.ok ? [] : outputLines(hooksRes.output),
      ),
    );
  }

  if (options.skipAudit === true) {
    checks.push(makeCheck('pnpm-audit', 'skip', 'dependency audit skipped (--skip-audit)'));
  } else {
    const auditRes = await deps.exec('pnpm', ['audit', '--audit-level=high']);
    if (auditRes.ok) {
      checks.push(
        makeCheck('pnpm-audit', 'pass', 'no high or critical dependency vulnerabilities'),
      );
    } else if (!ci && OFFLINE_AUDIT_RE.test(auditRes.output)) {
      checks.push(
        makeCheck(
          'pnpm-audit',
          'warn',
          'pnpm audit could not reach registry (offline); rerun online or in CI',
          outputLines(auditRes.output),
        ),
      );
    } else {
      checks.push(
        makeCheck(
          'pnpm-audit',
          'fail',
          'pnpm audit failed (high/critical vulnerabilities or audit error)',
          outputLines(auditRes.output),
        ),
      );
    }
  }

  const hasHygieneInputs =
    (options.artifacts?.length ?? 0) > 0 ||
    (options.androidManifests?.length ?? 0) > 0 ||
    (options.applePlists?.length ?? 0) > 0 ||
    (options.gradleDeps?.length ?? 0) > 0;
  if (!hasHygieneInputs) {
    checks.push(makeCheck('release-hygiene', 'skip', 'no release artifacts or manifests supplied'));
  } else {
    const resolveList = (list: readonly string[]): string[] =>
      list.map((p) => resolve(options.root, p));
    const hygieneRes = runReleaseHygiene({
      ...(options.artifacts === undefined ? {} : { artifacts: resolveList(options.artifacts) }),
      ...(options.androidManifests === undefined
        ? {}
        : { androidManifests: resolveList(options.androidManifests) }),
      ...(options.applePlists === undefined
        ? {}
        : { applePlists: resolveList(options.applePlists) }),
      ...(options.gradleDeps === undefined ? {} : { gradleDeps: resolveList(options.gradleDeps) }),
      ...(options.tv === undefined ? {} : { tv: options.tv }),
    });
    checks.push(
      makeCheck(
        'release-hygiene',
        hygieneRes.ok ? 'pass' : 'fail',
        hygieneRes.ok
          ? 'release hygiene checks passed'
          : `${hygieneRes.errors.length} release hygiene violation(s)`,
        hygieneRes.errors,
      ),
    );
  }

  checks.push(await runLgplLicencesCheck(options.root, deps));

  return {
    ok: checks.every((c) => c.status !== 'fail'),
    timestamp: (deps.now ?? (() => new Date().toISOString()))(),
    ci,
    checks,
  };
}
