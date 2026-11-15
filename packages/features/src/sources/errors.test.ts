import { elvError } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { describeSourceFailure, isEmptyImport } from './errors';

describe('describeSourceFailure and isEmptyImport', () => {
  it('maps each auth, network, format, and storage failure to a distinct localized message and hint', () => {
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
    }

    expect(describeSourceFailure(elvError('auth', 'http-401')).messageId).toBe(
      'source.error.invalidCredentials',
    );
    expect(describeSourceFailure(elvError('network', 'http-509')).messageId).toBe(
      'source.error.rateLimited',
    );
    expect(describeSourceFailure(elvError('network', 'http-429')).messageId).toBe(
      'source.error.rateLimited',
    );
    expect(describeSourceFailure(elvError('playback', 'decoder-failed')).messageId).toBe(
      'source.error.storage',
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
