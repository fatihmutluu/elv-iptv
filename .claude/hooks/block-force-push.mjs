#!/usr/bin/env node
// PreToolUse hook for the Bash and PowerShell tools: refuses `git push` invocations that can
// rewrite remote history. It is a guardrail for an agent that follows project rules, not a
// security boundary: it fails open on anything it cannot parse.
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

/** Reads a here-document body starting at `from`; returns null when the delimiter never appears. */
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

/**
 * Drops here-document bodies, which are data, unless the command line hands its stdin to a
 * shell interpreter (then the body is code and stays). Operators inside quotes, `<<<` and
 * heredocs without a terminating delimiter are left alone so nothing after them is hidden.
 */
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
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && prev !== '<' && prev !== '(') {
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

/** Splits a command line into segments of unquoted-aware tokens at shell separators. */
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
      else if (ch === '\\' && quote === '"' && /["\\]/.test(command[i + 1] ?? '')) current += command[++i];
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

const programName = (token) => basename(token.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');

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

/** Index of the program token after env assignments and wrappers together with their options. */
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

/** True when some command on the line reads its stdin as shell code. */
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
    if (payload.length > 0) return parseForcePush(payload.join(' '));
    return { blocked: false, reason: '' };
  }
  if (program !== 'git') return { blocked: false, reason: '' };
  i++;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    i += GIT_OPTIONS_WITH_VALUE.has(tokens[i]) ? 2 : 1;
  }
  if (tokens[i] !== 'push') return { blocked: false, reason: '' };
  for (const arg of tokens.slice(i + 1)) {
    const why = forceReason(arg);
    if (why) {
      return { blocked: true, reason: `git push with ${why} can rewrite remote history (force-push is forbidden)` };
    }
  }
  return { blocked: false, reason: '' };
}

/**
 * Decides whether a shell command contains a forbidden force-push.
 * Returns `{ blocked, reason }`; never throws, and any non-string input is allowed.
 */
export function parseForcePush(command) {
  try {
    if (typeof command !== 'string') return { blocked: false, reason: '' };
    for (const tokens of tokenize(stripHeredocs(command))) {
      const result = checkSegment(tokens);
      if (result.blocked) return result;
    }
  } catch {
    return { blocked: false, reason: '' };
  }
  return { blocked: false, reason: '' };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let command;
  try {
    command = JSON.parse(await readStdin())?.tool_input?.command;
  } catch {
    return 0;
  }
  const result = parseForcePush(command);
  if (!result.blocked) return 0;
  process.stderr.write(`Blocked: ${result.reason}. Use a normal push or ask the owner.\n`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
