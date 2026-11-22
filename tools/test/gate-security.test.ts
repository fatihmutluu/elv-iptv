import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { securityMain } from '../src/gates/security-cli.ts';
import {
  runSecurityGate,
  type SecurityGateDeps,
  type SecurityGateReport,
  scanStaticSecurityInvariants,
  systemSecurityDeps,
} from '../src/gates/security-gate.ts';
import { findRepoRoot } from '../src/root.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = 'elv_sec_gate_'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relPath: string, content: string): string {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

function makeCleanSyntheticRepo(): string {
  const root = makeTempDir('elv_sec_repo_');
  writeFile(
    root,
    'apps/desktop/src/main/window-options.ts',
    `export function buildWindowOptions() {
  return {
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}
`,
  );
  writeFile(
    root,
    'apps/desktop/src/main/player/presenter/video-window-options.ts',
    `export function buildVideoWindowOptions() {
  return {
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
}
`,
  );
  writeFile(
    root,
    'apps/desktop/electron-builder.yml',
    `appId: io.github.fatihmutluu.elviptv
electronFuses:
  runAsNode: false
  enableCookieEncryption: true
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
`,
  );
  writeFile(
    root,
    'apps/desktop/src/main/app-protocol.ts',
    `export const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; object-src 'none'";
`,
  );
  writeFile(
    root,
    'apps/desktop/src/main/serve-app.ts',
    `import { CONTENT_SECURITY_POLICY } from './app-protocol.ts';
export function withCsp(headers: Headers) {
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
}
`,
  );
  writeFile(root, 'packages/domain/src/safe.ts', 'export const ok = 1;\n');
  return root;
}

function makeFakeDeps(overrides: Partial<SecurityGateDeps> = {}): {
  deps: SecurityGateDeps;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const deps: SecurityGateDeps = {
    exec: async (command, args) => {
      calls.push({ command, args });
      return { ok: true, output: '' };
    },
    hasBinary: () => true,
    now: () => '2026-11-22T09:00:00.000Z',
    ...overrides,
  };
  return { deps, calls };
}

describe('scanStaticSecurityInvariants', () => {
  it('passes cleanly on a valid synthetic repo', () => {
    const root = makeCleanSyntheticRepo();
    expect(scanStaticSecurityInvariants(root)).toEqual([]);
  });

  it('passes cleanly on the real repository root', () => {
    const repoRoot = findRepoRoot(import.meta.dirname);
    expect(scanStaticSecurityInvariants(repoRoot)).toEqual([]);
  });

  it('fails when window-options.ts sets nodeIntegration: true', () => {
    const root = makeCleanSyntheticRepo();
    writeFile(
      root,
      'apps/desktop/src/main/window-options.ts',
      `export const opts = {
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: true,
    sandbox: true,
  },
};
`,
    );
    const violations = scanStaticSecurityInvariants(root);
    expect(
      violations.some((v) => v.includes('window-options.ts') && v.includes('nodeIntegration')),
    ).toBe(true);
  });

  it('fails when video-window-options.ts disables sandbox or sets webSecurity: false', () => {
    const root = makeCleanSyntheticRepo();
    writeFile(
      root,
      'apps/desktop/src/main/player/presenter/video-window-options.ts',
      `export const opts = {
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    webSecurity: false,
  },
};
`,
    );
    const violations = scanStaticSecurityInvariants(root);
    expect(
      violations.some((v) => v.includes('video-window-options.ts') && v.includes('sandbox')),
    ).toBe(true);
    expect(
      violations.some((v) => v.includes('video-window-options.ts') && v.includes('webSecurity')),
    ).toBe(true);
  });

  it('fails when any other desktop production file sets forbidden Electron webPreferences flags', () => {
    const root = makeCleanSyntheticRepo();
    writeFile(
      root,
      'apps/desktop/src/main/extra-window.ts',
      `export const extra = { webPreferences: { nodeIntegration: true, contextIsolation: false } };\n`,
    );
    writeFile(
      root,
      'apps/desktop/src/main/extra-window.test.ts',
      `export const mock = { webPreferences: { nodeIntegration: true } };\n`,
    );
    const violations = scanStaticSecurityInvariants(root);
    expect(
      violations.some(
        (v) =>
          v.includes('apps/desktop/src/main/extra-window.ts:1') &&
          v.includes('nodeIntegration: true'),
      ),
    ).toBe(true);
    expect(
      violations.some(
        (v) =>
          v.includes('apps/desktop/src/main/extra-window.ts:1') &&
          v.includes('contextIsolation: false'),
      ),
    ).toBe(true);
    expect(violations.some((v) => v.includes('extra-window.test.ts'))).toBe(false);
  });

  it('does not let regex literals with /* or backticks blind dangerous-sink scanning or corrupt comments', () => {
    const root = makeCleanSyntheticRepo();
    writeFile(
      root,
      'packages/domain/src/regex-charclass.ts',
      `const r1 = /[/*]/;\nexport const x = eval("1");\n`,
    );
    writeFile(
      root,
      'packages/domain/src/regex-slash-star.ts',
      `const r2 = /foo\\/*/;\nexport const w = eval("2");\n`,
    );
    writeFile(
      root,
      'packages/domain/src/regex-backtick.ts',
      'const r3 = /`|/;\n// comment mentioning eval("ignored")\nexport const y = eval("3");\n',
    );
    writeFile(
      root,
      'packages/domain/src/template-expr.ts',
      [
        'export const z = `ok $',
        '{/* ` */ eval("4")}`;\n// trailing comment eval("ignored")\n',
      ].join(''),
    );
    const violations = scanStaticSecurityInvariants(root);
    expect(violations.some((v) => v.includes('regex-charclass.ts:2') && v.includes('eval('))).toBe(
      true,
    );
    expect(violations.some((v) => v.includes('regex-slash-star.ts:2') && v.includes('eval('))).toBe(
      true,
    );
    expect(violations.some((v) => v.includes('regex-backtick.ts:2'))).toBe(false);
    expect(violations.some((v) => v.includes('regex-backtick.ts:3') && v.includes('eval('))).toBe(
      true,
    );
    expect(violations.some((v) => v.includes('template-expr.ts:1') && v.includes('eval('))).toBe(
      true,
    );
    expect(violations.some((v) => v.includes('template-expr.ts:2'))).toBe(false);
  });

  it('fails when an electron-builder.yml production fuse is missing or inverted', () => {
    const root = makeCleanSyntheticRepo();
    writeFile(
      root,
      'apps/desktop/electron-builder.yml',
      `appId: io.github.fatihmutluu.elviptv
electronFuses:
  runAsNode: true
  enableCookieEncryption: true
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true
`,
    );
    const violations = scanStaticSecurityInvariants(root);
    expect(violations.some((v) => v.includes('runAsNode: false'))).toBe(true);
    expect(violations.some((v) => v.includes('onlyLoadAppFromAsar: true'))).toBe(true);
  });

  it('fails when CSP contains unsafe-eval in app-protocol.ts or serve-app.ts', () => {
    const root = makeCleanSyntheticRepo();
    writeFile(
      root,
      'apps/desktop/src/main/app-protocol.ts',
      `export const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self' 'unsafe-eval'";
`,
    );
    expect(scanStaticSecurityInvariants(root).some((v) => v.includes('unsafe-eval'))).toBe(true);

    const root2 = makeCleanSyntheticRepo();
    writeFile(
      root2,
      'apps/desktop/src/main/serve-app.ts',
      `export const CONTENT_SECURITY_POLICY = "script-src 'self' 'unsafe-eval'";
`,
    );
    expect(scanStaticSecurityInvariants(root2).some((v) => v.includes('unsafe-eval'))).toBe(true);
  });

  it('detects eval(, new Function(, dangerouslySetInnerHTML, and shell.openExternal( in production source', () => {
    const root = makeCleanSyntheticRepo();
    writeFile(root, 'packages/domain/src/a.ts', 'export const a = eval("1+1");\n');
    writeFile(root, 'packages/sources/src/b.ts', 'export const b = new Function("return 1");\n');
    writeFile(
      root,
      'packages/ui-kit/src/c.tsx',
      'export const c = <div dangerouslySetInnerHTML={{ __html: "" }} />;\n',
    );
    writeFile(
      root,
      'apps/desktop/src/main/d.ts',
      'import { shell } from "electron";\nexport const open = (u: string) => shell.openExternal(u);\n',
    );

    const violations = scanStaticSecurityInvariants(root);
    expect(
      violations.some((v) => v.includes('packages/domain/src/a.ts:1') && v.includes('eval(')),
    ).toBe(true);
    expect(
      violations.some(
        (v) => v.includes('packages/sources/src/b.ts:1') && v.includes('new Function('),
      ),
    ).toBe(true);
    expect(
      violations.some(
        (v) => v.includes('packages/ui-kit/src/c.tsx:1') && v.includes('dangerouslySetInnerHTML'),
      ),
    ).toBe(true);
    expect(
      violations.some(
        (v) => v.includes('apps/desktop/src/main/d.ts:2') && v.includes('shell.openExternal('),
      ),
    ).toBe(true);
  });

  it('ignores comments and test, spec, e2e, testing, and __tests__ files', () => {
    const root = makeCleanSyntheticRepo();
    writeFile(
      root,
      'packages/domain/src/commented.ts',
      `// Never call eval(x) or shell.openExternal(url)
/*
 * new Function("bad")
 * dangerouslySetInnerHTML
 */
export const clean = true;
`,
    );
    writeFile(root, 'packages/domain/src/foo.test.ts', 'const x = eval("1");\n');
    writeFile(root, 'packages/domain/src/foo.spec.tsx', 'const y = new Function("return 1");\n');
    writeFile(root, 'apps/desktop/e2e/app.ts', 'shell.openExternal("https://example.com");\n');
    writeFile(
      root,
      'packages/ui-kit/testing/helper.tsx',
      '<div dangerouslySetInnerHTML={{}} />;\n',
    );
    writeFile(root, 'packages/features/__tests__/check.ts', 'eval("ok");\n');

    expect(scanStaticSecurityInvariants(root)).toEqual([]);
  });
});

describe('runSecurityGate', () => {
  it('passes when all checks succeed', async () => {
    const root = makeCleanSyntheticRepo();
    writeFile(root, '.agents/hooks/hooks.test.mjs', '// hook test\n');
    const { deps, calls } = makeFakeDeps();

    const report = await runSecurityGate({ root }, deps);
    expect(report.ok).toBe(true);
    expect(report.ci).toBe(false);
    expect(report.checks.find((c) => c.key === 'static-invariants')?.status).toBe('pass');
    expect(report.checks.find((c) => c.key === 'gitleaks-rules')?.status).toBe('pass');
    expect(report.checks.find((c) => c.key === 'gitleaks-git')?.status).toBe('pass');
    expect(report.checks.find((c) => c.key === 'agent-hooks')?.status).toBe('pass');
    expect(report.checks.find((c) => c.key === 'pnpm-audit')?.status).toBe('pass');
    expect(report.checks.find((c) => c.key === 'release-hygiene')?.status).toBe('skip');
    expect(report.checks.find((c) => c.key === 'lgpl-licences')?.status).toBe('skip');
    expect(calls.some((c) => c.command === 'gitleaks' && c.args[0] === 'git')).toBe(true);
    expect(calls.some((c) => c.command === 'pnpm' && c.args[0] === 'audit')).toBe(true);
  });

  it('fails when gitleaks-rules self-test fails', async () => {
    const root = makeCleanSyntheticRepo();
    const { deps } = makeFakeDeps({
      exec: async (command, args) => {
        if (command === 'node' && args[0] === 'scripts/test-gitleaks-rules.mjs') {
          return { ok: false, output: 'FAIL: live path (exit 0, expected 1)\n' };
        }
        return { ok: true, output: '' };
      },
    });

    const report = await runSecurityGate({ root }, deps);
    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.key === 'gitleaks-rules');
    expect(check?.status).toBe('fail');
    expect(check?.details.join('\n')).toContain('FAIL: live path');
  });

  it('warns locally when gitleaks binary is missing, but fails in --ci', async () => {
    const root = makeCleanSyntheticRepo();
    const { deps } = makeFakeDeps({
      hasBinary: (name) => name !== 'gitleaks',
      exec: async (command, args) => {
        if (command === 'node' && args[0] === 'scripts/test-gitleaks-rules.mjs') {
          return { ok: true, output: 'SKIP: gitleaks is not on PATH\n' };
        }
        return { ok: true, output: '' };
      },
    });

    const localReport = await runSecurityGate({ root, ci: false }, deps);
    expect(localReport.ok).toBe(true);
    expect(localReport.checks.find((c) => c.key === 'gitleaks-rules')?.status).toBe('warn');
    expect(localReport.checks.find((c) => c.key === 'gitleaks-git')?.status).toBe('warn');

    const ciReport = await runSecurityGate({ root, ci: true }, deps);
    expect(ciReport.ok).toBe(false);
    expect(ciReport.checks.find((c) => c.key === 'gitleaks-rules')?.status).toBe('fail');
    expect(ciReport.checks.find((c) => c.key === 'gitleaks-git')?.status).toBe('fail');
  });

  it('fails when pnpm audit reports vulnerabilities, warns offline locally, and skips with --skip-audit', async () => {
    const root = makeCleanSyntheticRepo();
    const { deps: vulnDeps } = makeFakeDeps({
      exec: async (command, args) => {
        if (command === 'pnpm' && args[0] === 'audit') {
          return { ok: false, output: '1 high severity vulnerability found\n' };
        }
        return { ok: true, output: '' };
      },
    });
    const vulnReport = await runSecurityGate({ root }, vulnDeps);
    expect(vulnReport.ok).toBe(false);
    expect(vulnReport.checks.find((c) => c.key === 'pnpm-audit')?.status).toBe('fail');

    const { deps: offlineDeps } = makeFakeDeps({
      exec: async (command, args) => {
        if (command === 'pnpm' && args[0] === 'audit') {
          return { ok: false, output: 'ERR_PNPM_AUDIT_NO_RESPONSE getaddrinfo ENOTFOUND\n' };
        }
        return { ok: true, output: '' };
      },
    });
    const offlineLocal = await runSecurityGate({ root, ci: false }, offlineDeps);
    expect(offlineLocal.ok).toBe(true);
    expect(offlineLocal.checks.find((c) => c.key === 'pnpm-audit')?.status).toBe('warn');

    const offlineCi = await runSecurityGate({ root, ci: true }, offlineDeps);
    expect(offlineCi.ok).toBe(false);
    expect(offlineCi.checks.find((c) => c.key === 'pnpm-audit')?.status).toBe('fail');

    const { deps: skipDeps, calls } = makeFakeDeps();
    const skipped = await runSecurityGate({ root, skipAudit: true }, skipDeps);
    expect(skipped.ok).toBe(true);
    expect(skipped.checks.find((c) => c.key === 'pnpm-audit')?.status).toBe('skip');
    expect(calls.some((c) => c.command === 'pnpm' && c.args[0] === 'audit')).toBe(false);
  });

  it('integrates release-hygiene when artifact or manifest flags are supplied', async () => {
    const root = makeCleanSyntheticRepo();
    const cleanArtifact = writeFile(root, 'dist-check/clean.js', 'console.log("hello");\n');
    const leakyArtifact = writeFile(
      root,
      'dist-check/leaky.js',
      'const k = "DEV_XTREAM_PASSWORD";\n',
    );
    const { deps } = makeFakeDeps();

    const passReport = await runSecurityGate({ root, artifacts: [cleanArtifact] }, deps);
    expect(passReport.ok).toBe(true);
    expect(passReport.checks.find((c) => c.key === 'release-hygiene')?.status).toBe('pass');

    const failReport = await runSecurityGate({ root, artifacts: [leakyArtifact] }, deps);
    expect(failReport.ok).toBe(false);
    const hygiene = failReport.checks.find((c) => c.key === 'release-hygiene');
    expect(hygiene?.status).toBe('fail');
    expect(hygiene?.details.join('\n')).toContain('DEV_XTREAM_PASSWORD');
  });

  it('integrates LGPL licence checks when local mpv or ffmpeg-media3 runtimes exist (even without BUILDINFO.json)', async () => {
    const root = makeCleanSyntheticRepo();
    writeFile(root, 'apps/desktop/resources/mpv/win32-x64/libmpv-2.dll', 'binary');
    writeFile(root, 'modules/engine-media3/vendor/ffmpeg-media3/BUILDINFO.json', '{}');

    const mpvDirs: string[] = [];
    const ffmpegDirs: string[] = [];
    const { deps: passDeps } = makeFakeDeps({
      verifyMpvDir: async (dir) => {
        mpvDirs.push(dir);
      },
      verifyFfmpegMedia3Dir: (dir) => {
        ffmpegDirs.push(dir);
      },
    });

    const passReport = await runSecurityGate({ root }, passDeps);
    expect(passReport.ok).toBe(true);
    expect(passReport.checks.find((c) => c.key === 'lgpl-licences')?.status).toBe('pass');
    expect(mpvDirs.length).toBe(1);
    expect(ffmpegDirs.length).toBe(1);

    const { deps: failDeps } = makeFakeDeps({
      verifyMpvDir: async () => {
        throw new Error('mpv: refused by the licence gate: --enable-gpl');
      },
      verifyFfmpegMedia3Dir: () => {
        throw new Error('ffmpeg-media3: embeds forbidden --enable-gpl');
      },
    });
    const failReport = await runSecurityGate({ root }, failDeps);
    expect(failReport.ok).toBe(false);
    const lgpl = failReport.checks.find((c) => c.key === 'lgpl-licences');
    expect(lgpl?.status).toBe('fail');
    expect(lgpl?.details.length).toBe(2);
  });

  it('systemSecurityDeps.hasBinary returns false for missing binaries and non-zero exit codes', () => {
    const deps = systemSecurityDeps(findRepoRoot(import.meta.dirname));
    expect(deps.hasBinary('definitely-missing-binary-elv-12345')).toBe(false);
    // `node version` exits non-zero (no file named "version"), proving exit status is checked.
    expect(deps.hasBinary('node')).toBe(false);
  });
});

describe('securityMain CLI', () => {
  it('writes report to --out or default CI path and returns exit codes 0 / 1', async () => {
    const root = makeTempDir('elv_sec_cli_');
    const outLines: string[] = [];
    const okReport: SecurityGateReport = {
      ok: true,
      timestamp: '2026-11-22T09:00:00.000Z',
      ci: true,
      checks: [
        { key: 'static-invariants', status: 'pass', summary: 'ok', details: [] },
        {
          key: 'gitleaks-git',
          status: 'warn',
          summary: 'skipped locally',
          details: ['install it'],
        },
      ],
    };

    const codeOk = await securityMain({ ci: true }, root, {
      stdout: (s) => outLines.push(s),
      runGate: async () => okReport,
    });
    expect(codeOk).toBe(0);
    const defaultCiOut = join(root, 'gate-artifacts', 'gate-security.json');
    expect(existsSync(defaultCiOut)).toBe(true);
    expect(JSON.parse(readFileSync(defaultCiOut, 'utf8')).ok).toBe(true);
    expect(outLines.join('')).toContain('::warning::');
    expect(outLines.join('')).toContain('gate security: passed');

    const failLines: string[] = [];
    const failReport: SecurityGateReport = {
      ok: false,
      timestamp: '2026-11-22T09:00:00.000Z',
      ci: false,
      checks: [
        { key: 'static-invariants', status: 'fail', summary: '1 violation', details: ['bad sink'] },
      ],
    };
    const customOut = join(root, 'custom-report.json');
    const codeFail = await securityMain({ out: customOut }, root, {
      stdout: (s) => failLines.push(s),
      runGate: async () => failReport,
    });
    expect(codeFail).toBe(1);
    expect(existsSync(customOut)).toBe(true);
    expect(failLines.join('')).toContain('FAIL');
    expect(failLines.join('')).toContain('gate security: FAILED');
  });

  it('escapes %, CR, and LF in GitHub Actions annotations when --ci is set', async () => {
    const root = makeTempDir('elv_sec_cli_esc_');
    const outLines: string[] = [];
    const multiLineReport: SecurityGateReport = {
      ok: false,
      timestamp: '2026-11-22T09:00:00.000Z',
      ci: true,
      checks: [
        {
          key: 'lgpl-licences',
          status: 'fail',
          summary: '1 failure',
          details: ['100% bad\r\n  - line2\n  - line3'],
        },
        {
          key: 'gitleaks-git',
          status: 'warn',
          summary: 'skipped',
          details: ['50% note\nsecond line'],
        },
      ],
    };
    const code = await securityMain({ ci: true }, root, {
      stdout: (s) => outLines.push(s),
      runGate: async () => multiLineReport,
    });
    expect(code).toBe(1);
    const text = outLines.join('');
    expect(text).toContain(
      '::error::gate security (lgpl-licences): 100%25 bad%0D%0A  - line2%0A  - line3',
    );
    expect(text).toContain('::warning::gate security (gitleaks-git): 50%25 note%0Asecond line');
  });
});
