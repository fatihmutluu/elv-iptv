/** Line limits for {@link checkFileSizes}. */
export interface FileSizeOptions {
  /** Lines above this produce a warning. Default 400. */
  soft?: number;
  /** Lines above this produce an error. Default 800. */
  hard?: number;
}

/** Findings of {@link checkFileSizes}. */
export interface FileSizeReport {
  warnings: string[];
  errors: string[];
}

const CHECKED = /\.(?:ts|tsx|mjs|cjs)$/;
const SKIPPED_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'release',
  'coverage',
  '.expo',
  'android',
  'ios',
  'generated',
]);

/** Vendored, built or generated paths are exempt from the limits. */
function isGeneratedPath(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts.some((p) => SKIPPED_SEGMENTS.has(p)) || /\.generated\./.test(parts.at(-1) ?? '');
}

/**
 * Checks `.ts/.tsx/.mjs/.cjs` sources against the soft and hard line limits.
 * `contents` maps repo-relative paths to file text; CRLF and LF count identically.
 */
export function checkFileSizes(
  contents: Record<string, string>,
  opts: FileSizeOptions = {},
): FileSizeReport {
  const soft = opts.soft ?? 400;
  const hard = opts.hard ?? 800;
  const report: FileSizeReport = { warnings: [], errors: [] };
  for (const [path, text] of Object.entries(contents)) {
    if (!CHECKED.test(path) || isGeneratedPath(path)) continue;
    const lines = countLines(text);
    const name = path.replace(/\\/g, '/');
    if (lines > hard) report.errors.push(`${name}: ${lines} lines (hard limit ${hard})`);
    else if (lines > soft) report.warnings.push(`${name}: ${lines} lines (soft limit ${soft})`);
  }
  return report;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}
