import { type ErrorCategory, elvError } from '@elv/domain';
import { createAppI18n } from '@elv/i18n';
import { describe, expect, it } from 'vitest';
import {
  describeSourceFailure,
  extractHttpStatus,
  isEmptyImport,
  sanitizeErrorDetail,
} from './errors';

describe('describeSourceFailure, extractHttpStatus, sanitizeErrorDetail and isEmptyImport (#63)', () => {
  it('maps each auth, network, format, storage, and playback failure to localized EN & TR messages and hints', () => {
    const en = createAppI18n('en');
    const tr = createAppI18n('tr');
    const cases = [
      elvError('auth', 'invalid-credentials'),
      elvError('auth', 'account-expired'),
      elvError('network', 'unreachable'),
      elvError('network', 'rate-limited'),
      elvError('network', 'timeout'),
      elvError('network', 'http-404'),
      elvError('network', 'aborted'),
      elvError('source-format', 'empty-source'),
      elvError('source-format', 'too-large'),
      elvError('source-format', 'not-m3u'),
      elvError('storage', 'import-in-progress'),
      elvError('storage', 'secret-store-failed'),
      elvError('storage', 'source-write-failed'),
    ];

    const seenMessages = new Set<string>();
    for (const err of cases) {
      const described = describeSourceFailure(err);
      expect(
        seenMessages.has(described.messageId),
        `duplicate messageId for ${err.category}/${err.code}`,
      ).toBe(false);
      seenMessages.add(described.messageId);
      expect(described.hintId).toMatch(/^source\.hint\./);
      expect(en.t(described.messageId).length).toBeGreaterThan(0);
      expect(tr.t(described.messageId).length).toBeGreaterThan(0);
      expect(en.t(described.hintId).length).toBeGreaterThan(0);
      expect(tr.t(described.hintId).length).toBeGreaterThan(0);
    }

    const categories: readonly ErrorCategory[] = [
      'auth',
      'network',
      'source-format',
      'storage',
      'playback',
    ];
    for (const category of categories) {
      const described = describeSourceFailure(elvError(category, 'unmapped-case'));
      expect(en.t(described.messageId).length).toBeGreaterThan(0);
      expect(tr.t(described.messageId).length).toBeGreaterThan(0);
      expect(en.t(described.hintId).length).toBeGreaterThan(0);
      expect(tr.t(described.hintId).length).toBeGreaterThan(0);
    }

    expect(describeSourceFailure(elvError('auth', 'http-401'))).toEqual({
      messageId: 'source.error.invalidCredentials',
      hintId: 'source.hint.invalidCredentials',
      httpStatus: 401,
    });
    expect(describeSourceFailure(elvError('auth', 'http-403')).httpStatus).toBe(403);
    expect(describeSourceFailure(elvError('network', 'http-404')).httpStatus).toBe(404);
    expect(describeSourceFailure(elvError('network', 'http-429'))).toEqual({
      messageId: 'source.error.rateLimited',
      hintId: 'source.hint.rateLimited',
      httpStatus: 429,
    });
    expect(describeSourceFailure(elvError('network', 'http-509'))).toEqual({
      messageId: 'source.error.rateLimited',
      hintId: 'source.hint.rateLimited',
      httpStatus: 509,
    });
    expect(describeSourceFailure(elvError('network', 'http-503'))).toEqual({
      messageId: 'source.error.unreachable',
      hintId: 'source.hint.unreachable',
      httpStatus: 503,
    });
    expect(describeSourceFailure(elvError('playback', 'decoder-failed')).messageId).toBe(
      'source.error.storage',
    );
  });

  it('extractHttpStatus parses 400..599 from error.code and safe detail patterns while ignoring non-HTTP numbers', () => {
    for (const code of [400, 401, 403, 404, 429, 500, 502, 503, 509, 599]) {
      expect(extractHttpStatus(elvError('network', `http-${code}`))).toBe(code);
    }
    expect(extractHttpStatus(elvError('network', 'http-200'))).toBeUndefined();
    expect(extractHttpStatus(elvError('network', 'http-304'))).toBeUndefined();
    expect(extractHttpStatus(elvError('network', 'http-600'))).toBeUndefined();
    expect(
      extractHttpStatus(elvError('network', 'unreachable', 'HTTP 503 Service Unavailable')),
    ).toBe(503);
    expect(extractHttpStatus(elvError('network', 'unreachable', 'status=429'))).toBe(429);
    expect(extractHttpStatus(elvError('auth', 'denied', 'status: 403'))).toBe(403);
    expect(
      extractHttpStatus(elvError('network', 'unreachable', 'http://host:500/live/404.ts')),
    ).toBeUndefined();
    expect(extractHttpStatus(elvError('storage', 'source-write-failed'))).toBeUndefined();
  });

  it('sanitizeErrorDetail blocks raw stack traces, JS/native class names, URLs, and credentials', () => {
    const blocked = [
      undefined,
      '',
      '   ',
      'TypeError: Failed to fetch',
      'AbortError: The operation was aborted',
      'Error: something broke',
      'SQLITE_ERROR: no such table',
      'ExoPlaybackException: Source error',
      'java.net.SocketTimeoutException: timeout',
      'connect ECONNREFUSED 10.0.0.1:8080',
      'line1\n    at fetch (file:///app/index.js:12:4)',
      'at parseM3u (src/parser.ts:42:10)',
      `https://alice:${'s'}ecret@iptv.example.test/get.php?${'user'}name=alice&${'pass'}word=demo`,
      'alice:secret@iptv.example.test',
      'Authorization Bearer eyJhbGciOi',
      'request failed for ?token=abc123',
    ];
    for (const sample of blocked) {
      expect(sanitizeErrorDetail(sample), `expected blocked: ${String(sample)}`).toBeUndefined();
    }
    expect(sanitizeErrorDetail('host=edge.example.test:8080 status=503')).toBe(
      'host=edge.example.test:8080 status=503',
    );
  });

  it('detects empty import summaries iff live + movies + series === 0', () => {
    expect(
      isEmptyImport({
        runId: 1,
        counts: {},
        warnings: 0,
        warningCodes: [],
        durationMs: 10,
      }),
    ).toBe(true);
    expect(
      isEmptyImport({
        runId: 2,
        counts: { live: 0, movies: 0, series: 0, categories: 3 },
        warnings: 0,
        warningCodes: [],
        durationMs: 10,
      }),
    ).toBe(true);
    expect(
      isEmptyImport({
        runId: 3,
        counts: { live: 1, movies: 0, series: 0 },
        warnings: 0,
        warningCodes: [],
        durationMs: 10,
      }),
    ).toBe(false);
    expect(
      isEmptyImport({
        runId: 4,
        counts: { movies: 2 },
        warnings: 0,
        warningCodes: [],
        durationMs: 10,
      }),
    ).toBe(false);
    expect(
      isEmptyImport({
        runId: 5,
        counts: { series: 1 },
        warnings: 0,
        warningCodes: [],
        durationMs: 10,
      }),
    ).toBe(false);
  });
});
