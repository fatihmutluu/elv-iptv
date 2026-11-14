import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LockError, parseLock, runtimeKey } from '../src/mpv/lock.ts';
import { findRepoRoot } from '../src/root.ts';

const HASH = '8e5f77430efc53ef175804ba6618527e3af0448a0dcabf04d3cc72659d1a6fce';
const good = {
  mpv: '0.42.0',
  kind: 'upstream-libmpv',
  url: 'https://github.com/mpv-player/mpv/releases/download/v0.42.0/a.zip',
  sha256: HASH,
};

describe('mpv runtime lock', () => {
  it('parses the committed lock', () => {
    const root = findRepoRoot(import.meta.dirname);
    const json = JSON.parse(readFileSync(join(root, 'apps/desktop/mpv-runtime.lock.json'), 'utf8'));
    const entry = parseLock(json)['win32-x64'];
    expect(entry?.sha256).toBe(HASH);
    expect(entry?.kind).toBe('upstream-libmpv');
    expect(entry && 'url' in entry && entry.url.startsWith('https://')).toBe(true);
  });

  it('rejects a sha256 that is not 64 lowercase hex', () => {
    expect(() => parseLock({ 'win32-x64': { ...good, sha256: 'ABC' } })).toThrow(LockError);
    expect(() => parseLock({ 'win32-x64': { ...good, sha256: 'ABC' } })).toThrow(
      /win32-x64\.sha256/,
    );
  });

  it('rejects an http url', () => {
    expect(() => parseLock({ 'win32-x64': { ...good, url: 'http://example.org/a.zip' } })).toThrow(
      /win32-x64\.url/,
    );
  });

  it('rejects an https url on another host', () => {
    expect(() => parseLock({ 'win32-x64': { ...good, url: 'https://example.org/a.zip' } })).toThrow(
      /win32-x64.url/,
    );
  });

  it('parses a workflow artifact entry', () => {
    const lock = parseLock({
      'darwin-arm64': {
        kind: 'workflow-artifact',
        mpv: '0.42.0',
        repo: 'o/r',
        runId: 5,
        artifact: 'a',
        file: 'f.tgz',
        sha256: HASH,
      },
    });
    expect(lock['darwin-arm64']?.kind).toBe('workflow-artifact');
  });

  it('rejects an unknown kind and a non-object', () => {
    expect(() => parseLock({ x: { ...good, kind: 'nope' } })).toThrow(/x\.kind/);
    expect(() => parseLock(null)).toThrow(LockError);
  });

  it('maps win32/x64 to win32-x64', () => {
    expect(runtimeKey('win32', 'x64')).toBe('win32-x64');
  });
});
