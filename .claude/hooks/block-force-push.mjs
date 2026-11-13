#!/usr/bin/env node
// PreToolUse hook for the Bash and PowerShell tools: refuses `git push` invocations that can
// rewrite remote history. It is a guardrail for an agent that follows project rules, not a
// security boundary: it fails open on anything it cannot parse.
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEPARATORS = new Set([';', '|', '&', '\n', '(', ')', '`']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'eval']);
const WRAPPERS = new Set(['command', 'env', 'sudo', 'time', 'exec', 'nohup', 'nice', 'call']);
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

/** Drops here-document bodies: their lines are data, not commands. */
function stripHeredocs(command) {
  const kept = [];
  let delimiter = null;
  let tabs = false;
  for (const line of command.split('\n')) {
    if (delimiter !== null) {
      if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) delimiter = null;
      continue;
    }
    kept.push(line);
    const match = /<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/.exec(line);
    if (match) {
      tabs = match[1] === '-';
      delimiter = match[3];
    }
  }
  return kept.join('\n');
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

function checkSegment(tokens) {
  let i = 0;
  while (i < tokens.length && (/^\w+=/.test(tokens[i]) || WRAPPERS.has(programName(tokens[i])))) i++;
  const program = tokens[i] === undefined ? '' : programName(tokens[i]);
  if (SHELLS.has(program)) {
    for (const arg of tokens.slice(i + 1)) {
      if (!arg.startsWith('-') && /git/i.test(arg)) {
        const inner = parseForcePush(arg);
        if (inner.blocked) return inner;
      }
    }
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
