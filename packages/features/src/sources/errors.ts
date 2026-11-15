import type { ImportSummary } from '@elv/data';
import type { ElvError } from '@elv/domain';
import type { MessageId } from '@elv/i18n';

/** Localized message and actionable recovery hint for a source add/import failure. */
export interface DescribedSourceFailure {
  readonly messageId: MessageId;
  readonly hintId: MessageId;
}

/** Maps a secret-free {@link ElvError} from `@elv/data` or `@elv/sources` to specific localized copy. */
export function describeSourceFailure(error: ElvError): DescribedSourceFailure {
  switch (error.category) {
    case 'auth':
      if (
        error.code === 'invalid-credentials' ||
        error.code === 'http-401' ||
        error.code === 'http-403'
      ) {
        return {
          messageId: 'source.error.invalidCredentials',
          hintId: 'source.hint.invalidCredentials',
        };
      }
      return {
        messageId: 'source.error.accountExpired',
        hintId: 'source.hint.accountExpired',
      };

    case 'network':
      if (error.code === 'aborted') {
        return {
          messageId: 'source.error.aborted',
          hintId: 'source.hint.aborted',
        };
      }
      if (error.code === 'rate-limited' || error.code === 'http-429' || error.code === 'http-509') {
        return {
          messageId: 'source.error.rateLimited',
          hintId: 'source.hint.rateLimited',
        };
      }
      if (error.code === 'timeout') {
        return {
          messageId: 'source.error.timeout',
          hintId: 'source.hint.timeout',
        };
      }
      if (error.code === 'http-404') {
        return {
          messageId: 'source.error.notFound',
          hintId: 'source.hint.notFound',
        };
      }
      return {
        messageId: 'source.error.unreachable',
        hintId: 'source.hint.unreachable',
      };

    case 'source-format':
      if (error.code === 'empty-source') {
        return {
          messageId: 'source.error.emptyPlaylist',
          hintId: 'source.hint.emptyPlaylist',
        };
      }
      if (error.code === 'too-large' || error.code === 'urlvars-too-large') {
        return {
          messageId: 'source.error.tooLarge',
          hintId: 'source.hint.tooLarge',
        };
      }
      return {
        messageId: 'source.error.invalidFormat',
        hintId: 'source.hint.invalidFormat',
      };

    case 'storage':
    case 'playback':
      if (error.code === 'import-in-progress') {
        return {
          messageId: 'source.error.importInProgress',
          hintId: 'source.hint.importInProgress',
        };
      }
      if (
        error.code === 'secret-store-failed' ||
        error.code === 'secret-write-failed' ||
        error.code === 'secret-missing' ||
        error.code === 'secret-delete-failed'
      ) {
        return {
          messageId: 'source.error.secretStore',
          hintId: 'source.hint.secretStore',
        };
      }
      return {
        messageId: 'source.error.storage',
        hintId: 'source.hint.storage',
      };
  }
}

/** Returns `true` when an import summary contains zero live channels, movies, and series. */
export function isEmptyImport(summary: ImportSummary): boolean {
  return (
    (summary.counts.live ?? 0) + (summary.counts.movies ?? 0) + (summary.counts.series ?? 0) === 0
  );
}
