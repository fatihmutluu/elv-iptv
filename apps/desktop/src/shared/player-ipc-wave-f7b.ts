/** Allowed keys on a `selectProgram` IPC command (`#304`). */
export const SELECT_PROGRAM_CMD_KEYS: ReadonlySet<string> = new Set(['name', 'attempt', 'id']);

const PROGRAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * Main/preload runtime guard for a multi-program MPEG-TS service/program identifier (`#304`).
 * Accepts non-empty ASCII numeric or alphanumeric identifiers (1–32 chars, no control chars or delimiters).
 */
export function isProgramId(x: unknown): x is string {
  return typeof x === 'string' && PROGRAM_ID_PATTERN.test(x);
}

/** Main/preload runtime guard for optional Wave F7B fields on `LoadCommand.options` (`#304`). */
export function hasValidWaveF7bLoadOptions(options: Record<string, unknown>): boolean {
  return options['programId'] === undefined || isProgramId(options['programId']);
}
