#!/usr/bin/env node
// Antigravity PreToolUse hook for ELV IPTV: enforces force-push prevention,
// secret/signing-key read/write blocks, generated-native-dir edit blocks,
// and confirmation prompts for release/repo-destructive gh commands.
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEPARATORS = new Set([';', '|', '&', '\n', '(', ')', '`']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'eval']);
const WRAPPERS = new Set(['command', 'env', 'sudo', 'time', 'exec', 'nohup', 'nice', 'call']);
const STDIN_SHELLS = new Set([...SHELLS].filter((s) => s !== 'eval').concat(['source', '.']));
const CODE_FLAG = /^(-[a-z]*c|-command|-commandwithargs|\/[ck])$/i;
const WRAPPER_VALUE_OPTIONS = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t']),
  env: new Set(['-u', '-C', '-S']),
  nice: new Set(['-n']),
  time: new Set(['-f', '-o']),
};
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--exec-path',
]);
const FORCE_LONG_OPTIONS = ['force', 'force-with-lease', 'force-if-includes', 'mirror'];

const READ_TOOLS = new Set(['read_file', 'view_file', 'grep_search']);
const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

const SECRET_FILE_RE =
  /(?:^|\/)(?:\.env(?:\.[^/]+)?\.local|[^/]+\.local\.env|secrets(?:\/|$)|[^/]+\.(?:jks|keystore|p8|p12|mobileprovision))$/i;
const GENERATED_NATIVE_RE = /(?:^|\/)(?:apps\/[^/]+\/(?:android|ios)(?:\/|$)|\.expo(?:\/|$))/i;

function readHeredocBody(command, from, delimiter, tabs) {
  let pos = from;
  while (pos <= command.length) {
    const eol = command.indexOf('\n', pos);
    const end = eol === -1 ? command.length : eol;
    const line = command.slice(pos, end);
    if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) {
      return { text: command.slice(from, pos), next: eol === -1 ? command.length : eol + 1 };
    }
    if (eol === -1) return null;
    pos = eol + 1;
  }
  return null;
}

function stripHeredocs(command) {
  let out = '';
  let lineStart = 0;
  let quote = null;
  let pending = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        out += ch + (command[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    const prev = command[i - 1];
    if (
      ch === '<' &&
      command[i + 1] === '<' &&
      command[i + 2] !== '<' &&
      prev !== '<' &&
      prev !== '('
    ) {
      const match = /^<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(command.slice(i));
      if (match) {
        pending.push({ delimiter: match[3], tabs: match[1] === '-' });
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    if (ch === '\n') {
      const keepBodies = pending.length > 0 && feedsShell(out.slice(lineStart));
      out += ch;
      i++;
      for (const { delimiter, tabs } of pending) {
        const body = readHeredocBody(command, i, delimiter, tabs);
        if (!body) break;
        if (keepBodies) out += body.text;
        i = body.next;
      }
      pending = [];
      lineStart = out.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function tokenize(command) {
  const segments = [];
  let tokens = [];
  let current = '';
  let inToken = false;
  let quote = null;
  const endToken = () => {
    if (inToken) tokens.push(current);
    current = '';
    inToken = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && /["\\]/.test(command[i + 1] ?? ''))
        current += command[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
    } else if (ch === '\\' && command[i + 1] === '\n') {
      endToken();
      i += 1;
    } else if (ch === '\\' && /["' ]/.test(command[i + 1] ?? '')) {
      current += command[++i];
      inToken = true;
    } else if (SEPARATORS.has(ch)) {
      endSegment();
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      current += ch;
      inToken = true;
    }
  }
  endSegment();
  return segments;
}

const programName = (token) =>
  basename(token.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.exe$/, '');

function forceReason(arg) {
  if (arg.startsWith('--')) {
    const name = arg.slice(2).split('=')[0];
    if (name.length >= 2 && FORCE_LONG_OPTIONS.some((o) => o.startsWith(name))) {
      return `option ${arg.split('=')[0]}`;
    }
    return null;
  }
  if (/^-[A-Za-z]+$/.test(arg) && arg.includes('f')) return `short flag ${arg}`;
  if (arg.startsWith('+')) return `forced refspec ${arg}`;
  return null;
}

function leadingIndex(tokens) {
  let i = 0;
  while (i < tokens.length) {
    if (/^\w+=/.test(tokens[i])) {
      i++;
      continue;
    }
    const wrapper = programName(tokens[i]);
    if (!WRAPPERS.has(wrapper)) break;
    i++;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      i += WRAPPER_VALUE_OPTIONS[wrapper]?.has(tokens[i]) ? 2 : 1;
    }
  }
  return i;
}

function feedsShell(line) {
  return tokenize(line).some((tokens) => {
    const program = tokens[leadingIndex(tokens)];
    return program !== undefined && STDIN_SHELLS.has(programName(program));
  });
}

function checkSegment(tokens) {
  let i = leadingIndex(tokens);
  const program = tokens[i] === undefined ? '' : programName(tokens[i]);
  if (SHELLS.has(program)) {
    const rest = tokens.slice(i + 1);
    const flag = rest.findIndex((t) => CODE_FLAG.test(t));
    const payload = program === 'eval' ? rest : flag >= 0 ? rest.slice(flag + 1) : [];
    if (payload.length > 0) return checkCommandPolicy(payload.join(' '));
    return { decision: 'allow' };
  }
  if (program === 'git') {
    i++;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      i += GIT_OPTIONS_WITH_VALUE.has(tokens[i]) ? 2 : 1;
    }
    if (tokens[i] === 'push') {
      for (const arg of tokens.slice(i + 1)) {
        const why = forceReason(arg);
        if (why) {
          return {
            decision: 'deny',
            reason: `Blocked: git push with ${why} can rewrite remote history (force-push is forbidden).`,
          };
        }
      }
    }
    return { decision: 'allow' };
  }
  if (program === 'gh') {
    const sub1 = tokens[i + 1];
    const sub2 = tokens[i + 2];
    if (
      (sub1 === 'release' && sub2 === 'create') ||
      (sub1 === 'repo' && sub2 === 'delete') ||
      (sub1 === 'repo' &&
        sub2 === 'edit' &&
        tokens.slice(i + 3).some((t) => t.startsWith('--visibility')))
    ) {
      return {
        decision: 'force_ask',
        reason:
          'Owner confirmation is required before creating a GitHub release, deleting a repo, or changing repo visibility.',
      };
    }
  }
  const readCmds = new Set([
    'cat',
    'type',
    'more',
    'less',
    'head',
    'tail',
    'get-content',
    'gc',
    'select-string',
    'sls',
    'rg',
    'grep',
  ]);
  if (readCmds.has(program)) {
    for (const arg of tokens.slice(i + 1)) {
      const norm = arg.replace(/\\/g, '/');
      if (SECRET_FILE_RE.test(norm)) {
        return {
          decision: 'deny',
          reason: `Blocked: reading secret or signing file "${arg}" is forbidden by ELV IPTV policy.`,
        };
      }
    }
  }
  return { decision: 'allow' };
}

/** Evaluates a shell command string against ELV IPTV PreToolUse guardrails. */
export function checkCommandPolicy(command) {
  try {
    if (typeof command !== 'string') return { decision: 'allow' };
    for (const tokens of tokenize(stripHeredocs(command))) {
      const result = checkSegment(tokens);
      if (result.decision !== 'allow') return result;
    }
  } catch {
    return { decision: 'allow' };
  }
  return { decision: 'allow' };
}

function checkFilePath(rawPath, isWrite) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return { decision: 'allow' };
  const norm = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (SECRET_FILE_RE.test(norm) || /(?:^|\/)secrets\//i.test(norm)) {
    return {
      decision: 'deny',
      reason: `Blocked: accessing secret or signing file "${rawPath}" is forbidden by ELV IPTV policy.`,
    };
  }
  if (isWrite && GENERATED_NATIVE_RE.test(norm)) {
    return {
      decision: 'deny',
      reason: `Blocked: editing generated folder "${rawPath}" is forbidden (expo prebuild generates apps/*/android and apps/*/ios).`,
    };
  }
  return { decision: 'allow' };
}

/** Evaluates an Antigravity PreToolUse JSON payload and returns `{ decision, reason? }`. */
export function evaluatePreToolUse(payload) {
  try {
    const toolName = String(payload?.toolCall?.name ?? '').toLowerCase();
    const args = payload?.toolCall?.args ?? {};
    if (toolName === 'run_command') {
      return checkCommandPolicy(args.CommandLine ?? args.command);
    }
    if (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) {
      const isWrite = WRITE_TOOLS.has(toolName);
      for (const candidate of [args.Path, args.AbsolutePath, args.SearchPath, args.TargetFile]) {
        const res = checkFilePath(candidate, isWrite);
        if (res.decision !== 'allow') return res;
      }
    }
  } catch {
    return { decision: 'allow' };
  }
  return { decision: 'allow' };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.stdout.write('{"decision":"allow"}\n');
    return 0;
  }
  const result = evaluatePreToolUse(payload);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
