import type { ImportSummary } from '@elv/data';
import type { ElvError } from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import { extractHttpStatus, sanitizeErrorDetail } from '../shared/error-utils';

export { extractHttpStatus, sanitizeErrorDetail };

/** Localized message, actionable recovery hint, and optional HTTP status code (`#63`). */
export interface DescribedSourceFailure {
  readonly messageId: MessageId;
  readonly hintId: MessageId;
  readonly httpStatus?: number;
}

function withStatus(
  messageId: MessageId,
  hintId: MessageId,
  httpStatus: number | undefined,
): DescribedSourceFailure {
  return httpStatus !== undefined ? { messageId, hintId, httpStatus } : { messageId, hintId };
}

/** Maps a secret-free {@link ElvError} from `@elv/data` or `@elv/sources` to specific localized copy. */
export function describeSourceFailure(error: ElvError): DescribedSourceFailure {
  const httpStatus = extractHttpStatus(error);
  switch (error.category) {
    case 'auth':
      if (
        error.code === 'invalid-credentials' ||
        error.code === 'http-401' ||
        error.code === 'http-403'
      ) {
        return withStatus(
          'source.error.invalidCredentials',
          'source.hint.invalidCredentials',
          httpStatus,
        );
      }
      return withStatus('source.error.accountExpired', 'source.hint.accountExpired', httpStatus);

    case 'network':
      if (error.code === 'aborted') {
        return withStatus('source.error.aborted', 'source.hint.aborted', httpStatus);
      }
      if (error.code === 'rate-limited' || error.code === 'http-429' || error.code === 'http-509') {
        return withStatus('source.error.rateLimited', 'source.hint.rateLimited', httpStatus);
      }
      if (error.code === 'timeout') {
        return withStatus('source.error.timeout', 'source.hint.timeout', httpStatus);
      }
      if (error.code === 'http-404') {
        return withStatus('source.error.notFound', 'source.hint.notFound', httpStatus);
      }
      return withStatus('source.error.unreachable', 'source.hint.unreachable', httpStatus);

    case 'source-format':
      if (error.code === 'empty-source') {
        return withStatus('source.error.emptyPlaylist', 'source.hint.emptyPlaylist', httpStatus);
      }
      if (error.code === 'too-large' || error.code === 'urlvars-too-large') {
        return withStatus('source.error.tooLarge', 'source.hint.tooLarge', httpStatus);
      }
      return withStatus('source.error.invalidFormat', 'source.hint.invalidFormat', httpStatus);

    case 'storage':
    case 'playback':
      if (error.code === 'import-in-progress') {
        return withStatus(
          'source.error.importInProgress',
          'source.hint.importInProgress',
          httpStatus,
        );
      }
      if (
        error.code === 'secret-store-failed' ||
        error.code === 'secret-write-failed' ||
        error.code === 'secret-missing' ||
        error.code === 'secret-delete-failed'
      ) {
        return withStatus('source.error.secretStore', 'source.hint.secretStore', httpStatus);
      }
      return withStatus('source.error.storage', 'source.hint.storage', httpStatus);
  }
}

/** Returns `true` when an import summary contains zero live channels, movies, and series. */
export function isEmptyImport(summary: ImportSummary): boolean {
  return (
    (summary.counts.live ?? 0) + (summary.counts.movies ?? 0) + (summary.counts.series ?? 0) === 0
  );
}
