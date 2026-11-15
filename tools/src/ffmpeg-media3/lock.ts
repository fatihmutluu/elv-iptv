/** Parsed `modules/engine-media3/ffmpeg-media3.lock.json` contract. */
export interface FfmpegMedia3Lock {
  repository: string;
  workflow: string;
  artifactName: string;
  ffmpegVersion: string;
  media3Version: string;
  runId: string | null;
  sha256: string | null;
}

/** Raised when `ffmpeg-media3.lock.json` is malformed or partially pinned. */
export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_ID_RE = /^[1-9][0-9]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LockError(`ffmpeg-media3.lock.json: "${key}" must be a non-empty string`);
  }
  return value;
}

/** Validates and parses the JSON text of `ffmpeg-media3.lock.json`. */
export function parseLock(raw: string): FfmpegMedia3Lock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new LockError(`ffmpeg-media3.lock.json: invalid JSON (${detail})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LockError('ffmpeg-media3.lock.json: root value must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const repository = requireString(obj, 'repository');
  if (!REPO_RE.test(repository)) {
    throw new LockError(
      `ffmpeg-media3.lock.json: "repository" must match owner/name (got "${repository}")`,
    );
  }
  const workflow = requireString(obj, 'workflow');
  const artifactName = requireString(obj, 'artifactName');
  const ffmpegVersion = requireString(obj, 'ffmpegVersion');
  const media3Version = requireString(obj, 'media3Version');

  const rawRunId = obj.runId;
  const rawSha = obj.sha256;
  if (rawRunId !== null && (typeof rawRunId !== 'string' || !RUN_ID_RE.test(rawRunId))) {
    throw new LockError(
      'ffmpeg-media3.lock.json: "runId" must be null or a positive integer string',
    );
  }
  if (rawSha !== null && (typeof rawSha !== 'string' || !SHA256_RE.test(rawSha))) {
    throw new LockError(
      'ffmpeg-media3.lock.json: "sha256" must be null or 64 lowercase hex characters',
    );
  }
  if ((rawRunId === null) !== (rawSha === null)) {
    throw new LockError(
      'ffmpeg-media3.lock.json: "runId" and "sha256" must both be null or both be pinned',
    );
  }

  return {
    repository,
    workflow,
    artifactName,
    ffmpegVersion,
    media3Version,
    runId: rawRunId,
    sha256: rawSha,
  };
}
