import { describe, expect, it } from 'vitest';
import type { EngineErrorCode } from './engine';
import { classifyError, type ErrorClass, toPlaybackError } from './errors';

const expected: Record<EngineErrorCode, ErrorClass> = {
  'http-401': 'terminal',
  'http-403': 'terminal',
  'unsupported-format': 'terminal',
  drm: 'terminal',
  'http-404': 'not-found',
  'http-429': 'limit',
  'http-509': 'limit',
  'connection-limit': 'limit',
  'http-other': 'recoverable',
  network: 'recoverable',
  decoder: 'recoverable',
  'surface-lost': 'recoverable',
  'engine-wedged': 'recoverable',
  unknown: 'recoverable',
};

describe('classifyError', () => {
  it.each(Object.entries(expected))('classifies %s as %s', (code, cls) => {
    expect(classifyError(code as EngineErrorCode)).toBe(cls);
  });
});

describe('toPlaybackError', () => {
  it('maps the code into the playback category', () => {
    expect(toPlaybackError({ code: 'http-509', httpStatus: 509 })).toEqual({
      category: 'playback',
      code: 'http-509',
    });
  });

  it('passes detail through only when present', () => {
    expect(toPlaybackError({ code: 'decoder', detail: 'avc1 failed' })).toEqual({
      category: 'playback',
      code: 'decoder',
      detail: 'avc1 failed',
    });
  });
});
