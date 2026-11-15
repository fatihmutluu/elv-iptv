import { describe, expect, it } from 'vitest';
import { LockError, parseLock } from '../src/ffmpeg-media3/lock.ts';

const VALID_PINNED = JSON.stringify({
  repository: 'fatihmutluu/elv-iptv',
  workflow: 'ffmpeg-media3.yml',
  artifactName: 'ffmpeg-media3-android',
  ffmpegVersion: '9.0.2',
  media3Version: '1.11.1',
  runId: '123456789',
  sha256: 'a'.repeat(64),
});

describe('ffmpeg-media3 lock parser', () => {
  it('parses a pinned lockfile', () => {
    const lock = parseLock(VALID_PINNED);
    expect(lock).toEqual({
      repository: 'fatihmutluu/elv-iptv',
      workflow: 'ffmpeg-media3.yml',
      artifactName: 'ffmpeg-media3-android',
      ffmpegVersion: '9.0.2',
      media3Version: '1.11.1',
      runId: '123456789',
      sha256: 'a'.repeat(64),
    });
  });

  it('parses an unpinned lockfile when both runId and sha256 are null', () => {
    const raw = JSON.stringify({
      ...JSON.parse(VALID_PINNED),
      runId: null,
      sha256: null,
    });
    const lock = parseLock(raw);
    expect(lock.runId).toBeNull();
    expect(lock.sha256).toBeNull();
  });

  it('rejects malformed JSON and non-object roots', () => {
    expect(() => parseLock('{not-json')).toThrow(LockError);
    expect(() => parseLock('[]')).toThrow(LockError);
    expect(() => parseLock('"string"')).toThrow(LockError);
  });

  it('rejects invalid repository, workflow, artifactName and versions', () => {
    expect(() =>
      parseLock(JSON.stringify({ ...JSON.parse(VALID_PINNED), repository: 'bad' })),
    ).toThrow(LockError);
    expect(() => parseLock(JSON.stringify({ ...JSON.parse(VALID_PINNED), workflow: '' }))).toThrow(
      LockError,
    );
    expect(() =>
      parseLock(JSON.stringify({ ...JSON.parse(VALID_PINNED), artifactName: '' })),
    ).toThrow(LockError);
    expect(() =>
      parseLock(JSON.stringify({ ...JSON.parse(VALID_PINNED), ffmpegVersion: '' })),
    ).toThrow(LockError);
    expect(() =>
      parseLock(JSON.stringify({ ...JSON.parse(VALID_PINNED), media3Version: 111 })),
    ).toThrow(LockError);
  });

  it('rejects malformed runId, malformed sha256, or half-pinned entries', () => {
    expect(() => parseLock(JSON.stringify({ ...JSON.parse(VALID_PINNED), runId: '0123' }))).toThrow(
      LockError,
    );
    expect(() => parseLock(JSON.stringify({ ...JSON.parse(VALID_PINNED), runId: 'abc' }))).toThrow(
      LockError,
    );
    expect(() =>
      parseLock(JSON.stringify({ ...JSON.parse(VALID_PINNED), sha256: 'A'.repeat(64) })),
    ).toThrow(LockError);
    expect(() =>
      parseLock(JSON.stringify({ ...JSON.parse(VALID_PINNED), sha256: 'deadbeef' })),
    ).toThrow(LockError);
    expect(() => parseLock(JSON.stringify({ ...JSON.parse(VALID_PINNED), runId: null }))).toThrow(
      LockError,
    );
    expect(() => parseLock(JSON.stringify({ ...JSON.parse(VALID_PINNED), sha256: null }))).toThrow(
      LockError,
    );
  });
});
