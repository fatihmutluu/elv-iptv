import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDevEnv, parseEnvFile } from '../src/env.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseEnvFile', () => {
  it('parses CRLF files without leaking carriage returns', () => {
    const env = parseEnvFile('DEV_HOST=http://h.example\r\nDEV_USER=abc\r\n');
    expect(env).toEqual({ DEV_HOST: 'http://h.example', DEV_USER: 'abc' });
  });

  it('skips comments and blank lines and strips matching quotes', () => {
    const env = parseEnvFile('# note\n\nA="x y"\nB=\'z\'\nC=plain # not a comment\n');
    expect(env).toEqual({ A: 'x y', B: 'z', C: 'plain # not a comment' });
  });

  it('keeps equals signs inside values and ignores malformed lines', () => {
    expect(parseEnvFile('K=a=b\nnoequals\n=x\n')).toEqual({ K: 'a=b' });
  });

  it('accepts an export prefix and a leading BOM', () => {
    expect(parseEnvFile('﻿export A=1\n')).toEqual({ A: '1' });
  });
});

describe('loadDevEnv', () => {
  it('returns an empty object when the file is missing', () => {
    expect(loadDevEnv(join(tmpdir(), 'elv-missing-env-file'))).toEqual({});
  });

  it('reads and parses an existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv_env_'));
    dirs.push(dir);
    const file = join(dir, 'env');
    writeFileSync(file, 'DEV_X=1\r\n');
    expect(loadDevEnv(file)).toEqual({ DEV_X: '1' });
  });
});
