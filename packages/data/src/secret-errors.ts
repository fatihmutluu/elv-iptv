/**
 * Recognizes an error raised when an existing encrypted secret could not be decrypted because the
 * host OS key was rotated or lost (e.g. Electron `SecretDecryptError` or utility-worker reply).
 */
export function isSecretKeyRotatedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === 'storage/secret-key-rotated' ||
    candidate.message === 'storage/secret-key-rotated'
  );
}
