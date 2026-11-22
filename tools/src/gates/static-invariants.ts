import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const WINDOW_OPTION_FILES = [
  'apps/desktop/src/main/window-options.ts',
  'apps/desktop/src/main/player/presenter/video-window-options.ts',
] as const;

const REQUIRED_WINDOW_FLAGS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: 'contextIsolation: true', regex: /\bcontextIsolation\s*:\s*true\b/ },
  { label: 'nodeIntegration: false', regex: /\bnodeIntegration\s*:\s*false\b/ },
  { label: 'sandbox: true', regex: /\bsandbox\s*:\s*true\b/ },
];

const FORBIDDEN_WINDOW_FLAGS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: 'nodeIntegration: true', regex: /\bnodeIntegration\s*:\s*true\b/ },
  { label: 'contextIsolation: false', regex: /\bcontextIsolation\s*:\s*false\b/ },
  { label: 'sandbox: false', regex: /\bsandbox\s*:\s*false\b/ },
  { label: 'webSecurity: false', regex: /\bwebSecurity\s*:\s*false\b/ },
];

const REQUIRED_ELECTRON_FUSES: ReadonlyArray<readonly [string, string]> = [
  ['runAsNode', 'false'],
  ['enableCookieEncryption', 'true'],
  ['enableNodeOptionsEnvironmentVariable', 'false'],
  ['enableNodeCliInspectArguments', 'false'],
  ['enableEmbeddedAsarIntegrityValidation', 'true'],
  ['onlyLoadAppFromAsar', 'true'],
];

const DANGEROUS_SINKS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: 'eval(', regex: /\beval\s*\(/ },
  { label: 'new Function(', regex: /\bnew\s+Function\s*\(/ },
  { label: 'dangerouslySetInnerHTML', regex: /\bdangerouslySetInnerHTML\b/ },
  { label: 'shell.openExternal(', regex: /\bshell\.openExternal\s*\(/ },
];

const SKIP_DIRS = new Set(
  'node_modules dist build release android ios .expo e2e testing __tests__ .git .cache'.split(' '),
);
const REGEX_PRECEDING_KEYWORDS = new Set(
  'return throw case in instanceof typeof void delete new yield await of else do export default'.split(
    ' ',
  ),
);

const SOURCE_FILE_RE = /\.(?:ts|tsx|js|mjs|cjs)$/i;
const TEST_FILE_RE = /\.(?:test|spec)\.[^.]+$/i;

function scanRegexLiteralEnd(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '\n' || ch === '\r') return -1;
    if (ch === '\\') {
      if (i + 1 >= source.length || source[i + 1] === '\n' || source[i + 1] === '\r') return -1;
      i += 2;
      continue;
    }
    if (ch === '[') {
      inClass = true;
    } else if (ch === ']' && inClass) {
      inClass = false;
    } else if (ch === '/' && !inClass) {
      i += 1;
      while (i < source.length && /[a-zA-Z]/.test(source[i] as string)) i += 1;
      return i;
    }
    i += 1;
  }
  return -1;
}

/** Strips JS/TS comments while preserving newlines and respecting strings, templates, and regex literals. */
function stripJsComments(source: string): string {
  const out: string[] = [];
  const templateBraceDepths: number[] = [];
  let inTemplate = false;
  let regexAllowed = true;
  let i = 0;

  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (inTemplate) {
      if (ch === '\\' && next !== undefined) {
        out.push(ch, next);
        i += 2;
      } else if (ch === '`') {
        out.push(ch);
        i += 1;
        inTemplate = false;
        regexAllowed = false;
      } else if (ch === '$' && next === '{') {
        out.push('${');
        i += 2;
        inTemplate = false;
        templateBraceDepths.push(0);
        regexAllowed = true;
      } else {
        out.push(ch);
        i += 1;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      out.push(ch);
      i += 1;
      while (i < source.length) {
        const sc = source[i] as string;
        out.push(sc);
        if (sc === '\\' && i + 1 < source.length) {
          out.push(source[i + 1] as string);
          i += 2;
          continue;
        }
        i += 1;
        if (sc === quote || sc === '\n') break;
      }
      regexAllowed = false;
      continue;
    }

    if (ch === '`') {
      out.push(ch);
      i += 1;
      inTemplate = true;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out.push(' ');
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      out.push('  ');
      i += 2;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          out.push('  ');
          i += 2;
          break;
        }
        out.push(source[i] === '\n' ? '\n' : ' ');
        i += 1;
      }
      continue;
    }

    const prev = i > 0 ? source[i - 1] : '';
    if (ch === '/' && regexAllowed && prev !== '<') {
      const end = scanRegexLiteralEnd(source, i);
      if (end !== -1) {
        out.push(source.slice(i, end));
        i = end;
        regexAllowed = false;
        continue;
      }
    }

    if (ch === '{') {
      if (templateBraceDepths.length > 0) {
        const top = templateBraceDepths.length - 1;
        templateBraceDepths[top] = (templateBraceDepths[top] ?? 0) + 1;
      }
      out.push(ch);
      i += 1;
      regexAllowed = true;
      continue;
    }

    if (ch === '}') {
      if (templateBraceDepths.length > 0) {
        const top = templateBraceDepths.length - 1;
        const depth = templateBraceDepths[top] ?? 0;
        if (depth === 0) {
          templateBraceDepths.pop();
          out.push(ch);
          i += 1;
          inTemplate = true;
          continue;
        }
        templateBraceDepths[top] = depth - 1;
      }
      out.push(ch);
      i += 1;
      regexAllowed = true;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i] as string)) i += 1;
      const word = source.slice(start, i);
      out.push(word);
      regexAllowed = REGEX_PRECEDING_KEYWORDS.has(word);
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < source.length && /[0-9a-zA-Z_.]/.test(source[i] as string)) i += 1;
      out.push(source.slice(start, i));
      regexAllowed = false;
      continue;
    }

    out.push(ch);
    i += 1;
    if (ch === ')' || ch === ']') {
      regexAllowed = false;
    } else if (!/\s/.test(ch)) {
      regexAllowed = '([,;:?!=&|^~+*%<>/-'.includes(ch);
    }
  }

  return out.join('');
}

function walkProductionSources(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkProductionSources(full, out);
      continue;
    }
    if (entry.isFile() && SOURCE_FILE_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
}

function checkElectronWindows(root: string, violations: string[]): void {
  for (const rel of WINDOW_OPTION_FILES) {
    const full = join(root, rel);
    if (!existsSync(full)) {
      violations.push(`${rel}: missing required Electron window options file`);
      continue;
    }
    const code = stripJsComments(readFileSync(full, 'utf8'));
    for (const req of REQUIRED_WINDOW_FLAGS) {
      if (!req.regex.test(code)) {
        violations.push(`${rel}: missing required webPreferences flag "${req.label}"`);
      }
    }
  }

  const desktopFiles: string[] = [];
  walkProductionSources(join(root, 'apps', 'desktop', 'src'), desktopFiles);
  desktopFiles.sort();
  for (const file of desktopFiles) {
    const rel = relative(root, file).replaceAll('\\', '/');
    const lines = stripJsComments(readFileSync(file, 'utf8')).split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? '';
      for (const bad of FORBIDDEN_WINDOW_FLAGS) {
        if (bad.regex.test(line)) {
          violations.push(`${rel}:${idx + 1}: forbidden webPreferences flag "${bad.label}"`);
        }
      }
    }
  }
}

function parseElectronFuses(yamlText: string): Map<string, string> | null {
  const fuses = new Map<string, string>();
  let inBlock = false;
  let blockIndent = -1;
  for (const rawLine of yamlText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (!inBlock) {
      if (/^electronFuses\s*:\s*$/.test(line.trim())) {
        inBlock = true;
        blockIndent = indent;
      }
      continue;
    }
    if (indent <= blockIndent) break;
    const match = /^\s*([A-Za-z0-9_]+)\s*:\s*(\S+)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) fuses.set(match[1], match[2]);
  }
  return inBlock ? fuses : null;
}

function checkElectronFuses(root: string, violations: string[]): void {
  const rel = 'apps/desktop/electron-builder.yml';
  const full = join(root, rel);
  if (!existsSync(full)) {
    violations.push(`${rel}: missing Electron builder configuration`);
    return;
  }
  const fuses = parseElectronFuses(readFileSync(full, 'utf8'));
  if (fuses === null) {
    violations.push(`${rel}: missing electronFuses section`);
    return;
  }
  for (const [key, expected] of REQUIRED_ELECTRON_FUSES) {
    const actual = fuses.get(key);
    if (actual !== expected) {
      violations.push(
        `${rel}: electronFuses.${key} must be ${key}: ${expected} (found ${actual ?? 'missing'})`,
      );
    }
  }
}

function checkDesktopCsp(root: string, violations: string[]): void {
  const serveRel = 'apps/desktop/src/main/serve-app.ts';
  const serveFull = join(root, serveRel);
  if (!existsSync(serveFull)) {
    violations.push(`${serveRel}: missing desktop app server file`);
    return;
  }
  const serveCode = stripJsComments(readFileSync(serveFull, 'utf8'));
  if (!/\bCONTENT_SECURITY_POLICY\b/.test(serveCode)) {
    violations.push(`${serveRel}: must define or apply CONTENT_SECURITY_POLICY`);
  }
  if (/unsafe-eval/i.test(serveCode)) {
    violations.push(`${serveRel}: CONTENT_SECURITY_POLICY must not allow 'unsafe-eval'`);
  }
  if (!/\bCONTENT_SECURITY_POLICY\s*=/.test(serveCode)) {
    const protoRel = 'apps/desktop/src/main/app-protocol.ts';
    const protoFull = join(root, protoRel);
    if (!existsSync(protoFull)) {
      violations.push(`${protoRel}: missing CONTENT_SECURITY_POLICY definition`);
      return;
    }
    const protoCode = stripJsComments(readFileSync(protoFull, 'utf8'));
    if (!/\bCONTENT_SECURITY_POLICY\s*=/.test(protoCode)) {
      violations.push(`${protoRel}: must define CONTENT_SECURITY_POLICY`);
    }
    if (/unsafe-eval/i.test(protoCode)) {
      violations.push(`${protoRel}: CONTENT_SECURITY_POLICY must not allow 'unsafe-eval'`);
    }
  }
}

function checkDangerousSinks(root: string, violations: string[]): void {
  const files: string[] = [];
  for (const top of ['apps', 'packages', 'modules']) walkProductionSources(join(root, top), files);
  files.sort();
  for (const file of files) {
    const rel = relative(root, file).replaceAll('\\', '/');
    const lines = stripJsComments(readFileSync(file, 'utf8')).split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? '';
      for (const sink of DANGEROUS_SINKS) {
        if (sink.regex.test(line)) {
          violations.push(`${rel}:${idx + 1}: forbidden dangerous sink "${sink.label}"`);
        }
      }
    }
  }
}

/**
 * Inspects static repository security invariants: Electron window flags across desktop sources,
 * production fuses, CSP without `'unsafe-eval'`, and absence of dangerous JS/Electron sinks.
 */
export function scanStaticSecurityInvariants(root: string): string[] {
  const violations: string[] = [];
  checkElectronWindows(root, violations);
  checkElectronFuses(root, violations);
  checkDesktopCsp(root, violations);
  checkDangerousSinks(root, violations);
  return violations;
}
