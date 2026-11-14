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

const committed = (): ReturnType<typeof parseLock> => {
  const root = findRepoRoot(import.meta.dirname);
  return parseLock(
    JSON.parse(readFileSync(join(root, 'apps/desktop/mpv-runtime.lock.json'), 'utf8')),
  );
};

describe('mpv runtime lock', () => {
  it('parses the committed lock', () => {
    const entry = committed()['win32-x64'];
    expect(entry?.sha256).toBe(HASH);
    expect(entry?.kind).toBe('upstream-libmpv');
    expect(entry && 'url' in entry && entry.url.startsWith('https://')).toBe(true);
  });

  it('pins the macOS runtime to the mpv-runtime.yml artifact of this repository', () => {
    const entry = committed()['darwin-arm64'];
    expect(entry).toMatchObject({
      kind: 'workflow-artifact',
      mpv: '0.42.0',
      repo: 'fatihmutluu/elv-iptv',
      artifact: 'mpv-runtime-darwin-arm64',
      file: 'mpv-runtime-darwin-arm64.tar.gz',
    });
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

  const artifact = {
    kind: 'workflow-artifact',
    mpv: '0.42.0',
    repo: 'fatihmutluu/elv-iptv',
    runId: 5,
    artifact: 'mpv-runtime-darwin-arm64',
    file: 'mpv-runtime-darwin-arm64.tar.gz',
    sha256: HASH,
  };

  it('parses a workflow-artifact entry', () => {
    expect(parseLock({ 'darwin-arm64': artifact })['darwin-arm64']).toEqual(artifact);
  });

  it.each([1.5, '5', 0, -3])('rejects a non-integer runId (%s)', (runId) => {
    expect(() => parseLock({ 'darwin-arm64': { ...artifact, runId } })).toThrow(
      /darwin-arm64\.runId must be a positive integer/,
    );
  });

  it('rejects an unknown kind and a non-object', () => {
    expect(() => parseLock({ x: { ...good, kind: 'nope' } })).toThrow(/x\.kind/);
    expect(() => parseLock(null)).toThrow(LockError);
  });

  it('maps win32/x64 to win32-x64', () => {
    expect(runtimeKey('win32', 'x64')).toBe('win32-x64');
  });
});
