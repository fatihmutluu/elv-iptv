import { existsSync, readFileSync } from 'node:fs';

/**
 * Parses dotenv-style content. Handles CRLF, a BOM, `export` prefixes, blank lines,
 * `#` comment lines and single or double quoted values. Malformed lines are skipped.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of content.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, '')
      .trim();
    if (key === '') continue;
    env[key] = unquote(line.slice(eq + 1).trim());
  }
  return env;
}

function unquote(value: string): string {
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    return value.slice(1, -1);
  }
  return value;
}

/** Reads a dev env file such as `.env.local`; returns `{}` when it does not exist. */
export function loadDevEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnvFile(readFileSync(path, 'utf8'));
}
