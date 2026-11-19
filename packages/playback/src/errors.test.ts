import { describe, expect, it } from 'vitest';
import type { EngineErrorCode } from './engine';
import { classifyError, codeForHttpStatus, type ErrorClass, toPlaybackError } from './errors';

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

  it('classifies HTTP 407/410/451 as terminal and 458/460-463/469 as limit via httpStatus (#286, #314)', () => {
    expect(classifyError('http-401', 407)).toBe('terminal');
    expect(classifyError('http-404', 410)).toBe('terminal');
    expect(classifyError('http-404', 451)).toBe('terminal');
    for (const status of [401, 403, 407, 410, 451]) {
      expect(classifyError('http-other', status), `status ${status}`).toBe('terminal');
    }
    expect(classifyError('http-other', 404)).toBe('not-found');
    for (const status of [429, 458, 460, 461, 462, 463, 469, 509]) {
      expect(classifyError('http-other', status), `status ${status}`).toBe('limit');
    }
    expect(classifyError('http-other', 503)).toBe('recoverable');

    expect(codeForHttpStatus(407)).toBe('http-401');
    expect(codeForHttpStatus(410)).toBe('http-404');
    expect(codeForHttpStatus(451)).toBe('http-404');
    expect(codeForHttpStatus(458)).toBe('connection-limit');
    expect(codeForHttpStatus(469)).toBe('connection-limit');
    expect(codeForHttpStatus(502)).toBe('http-other');
  });
});

describe('toPlaybackError', () => {
  it('maps the code into the playback category and normalizes http-other refusal statuses', () => {
    expect(toPlaybackError({ code: 'http-509', httpStatus: 509 })).toEqual({
      category: 'playback',
      code: 'http-509',
    });
    expect(toPlaybackError({ code: 'http-other', httpStatus: 410 })).toEqual({
      category: 'playback',
      code: 'http-404',
    });
    expect(toPlaybackError({ code: 'http-other', httpStatus: 407 })).toEqual({
      category: 'playback',
      code: 'http-401',
    });
    expect(toPlaybackError({ code: 'http-other', httpStatus: 460 })).toEqual({
      category: 'playback',
      code: 'connection-limit',
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
