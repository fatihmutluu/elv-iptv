/** Supported external player handoff modes (`#406`). */
export const EXTERNAL_PLAYER_MODES = ['off', 'ask', 'always'] as const;

/** User-selectable external player handoff mode (`#406`). */
export type ExternalPlayerMode = (typeof EXTERNAL_PLAYER_MODES)[number];

/** Safe RFC 3986 URI scheme pattern for optional custom external player scheme (`#406`). */
export const EXTERNAL_PLAYER_SCHEME_RE = /^[a-z][a-z0-9+.-]{0,31}$/i;

/** Wave F7B crash diagnostics and external player preference fields (`#226`, `#406`). */
export interface WaveF7bPreferencesFields {
  readonly crashReportsOptIn: boolean;
  readonly crashReportsIncludeLogs: boolean;
  readonly externalPlayerMode: ExternalPlayerMode;
  readonly externalPlayerCustomScheme: string;
}

/** Default values for all Wave F7B preference fields. */
export const DEFAULT_WAVE_F7B_PREFERENCES: WaveF7bPreferencesFields = Object.freeze({
  crashReportsOptIn: false,
  crashReportsIncludeLogs: false,
  externalPlayerMode: 'off',
  externalPlayerCustomScheme: '',
});

/** Returns true when `value` is a supported {@link ExternalPlayerMode}. */
export function isExternalPlayerMode(value: unknown): value is ExternalPlayerMode {
  return typeof value === 'string' && (EXTERNAL_PLAYER_MODES as readonly string[]).includes(value);
}

/** Returns true when `value` is empty or a safe URI scheme name (never a full URL or credentials). */
export function isValidExternalPlayerScheme(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length === 0 || EXTERNAL_PLAYER_SCHEME_RE.test(trimmed);
}

/** Normalizes a custom external player URI scheme to lowercase or falls back when invalid. */
export function normalizeExternalPlayerScheme(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  return EXTERNAL_PLAYER_SCHEME_RE.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function parseWaveF7bPreferences(
  parsed: Record<string, unknown>,
  defaults: WaveF7bPreferencesFields,
): WaveF7bPreferencesFields {
  return {
    crashReportsOptIn: boolOr(parsed.crashReportsOptIn, defaults.crashReportsOptIn),
    crashReportsIncludeLogs: boolOr(
      parsed.crashReportsIncludeLogs,
      defaults.crashReportsIncludeLogs,
    ),
    externalPlayerMode: isExternalPlayerMode(parsed.externalPlayerMode)
      ? parsed.externalPlayerMode
      : defaults.externalPlayerMode,
    externalPlayerCustomScheme: normalizeExternalPlayerScheme(
      parsed.externalPlayerCustomScheme,
      defaults.externalPlayerCustomScheme,
    ),
  };
}

export function serializeWaveF7bPreferences(
  snapshot: WaveF7bPreferencesFields,
  defaults: WaveF7bPreferencesFields,
): Partial<WaveF7bPreferencesFields> {
  const crashReportsOptIn = Boolean(snapshot.crashReportsOptIn);
  const crashReportsIncludeLogs = Boolean(snapshot.crashReportsIncludeLogs);
  const externalPlayerMode = isExternalPlayerMode(snapshot.externalPlayerMode)
    ? snapshot.externalPlayerMode
    : defaults.externalPlayerMode;
  const externalPlayerCustomScheme = normalizeExternalPlayerScheme(
    snapshot.externalPlayerCustomScheme,
    defaults.externalPlayerCustomScheme,
  );

  return {
    ...(crashReportsOptIn === defaults.crashReportsOptIn ? {} : { crashReportsOptIn }),
    ...(crashReportsIncludeLogs === defaults.crashReportsIncludeLogs
      ? {}
      : { crashReportsIncludeLogs }),
    ...(externalPlayerMode === defaults.externalPlayerMode ? {} : { externalPlayerMode }),
    ...(externalPlayerCustomScheme === defaults.externalPlayerCustomScheme
      ? {}
      : { externalPlayerCustomScheme }),
  };
}

export function mergeWaveF7bPreferences(
  base: WaveF7bPreferencesFields,
  patch: Partial<WaveF7bPreferencesFields>,
): WaveF7bPreferencesFields {
  return {
    crashReportsOptIn: boolOr(patch.crashReportsOptIn, base.crashReportsOptIn),
    crashReportsIncludeLogs: boolOr(patch.crashReportsIncludeLogs, base.crashReportsIncludeLogs),
    externalPlayerMode: isExternalPlayerMode(patch.externalPlayerMode)
      ? patch.externalPlayerMode
      : base.externalPlayerMode,
    externalPlayerCustomScheme:
      patch.externalPlayerCustomScheme !== undefined
        ? normalizeExternalPlayerScheme(
            patch.externalPlayerCustomScheme,
            base.externalPlayerCustomScheme,
          )
        : base.externalPlayerCustomScheme,
  };
}
