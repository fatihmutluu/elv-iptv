/** Supported Auto Frame-Rate (AFR) display refresh switching modes (`#116`, `#188`, `#199`, `#214`). */
export const AUTO_FRAME_RATE_MODES = ['off', 'seamless', 'always'] as const;

/** User-selectable Auto Frame-Rate (AFR) display switching mode (`#116`, `#188`, `#199`, `#214`). */
export type AutoFrameRateMode = (typeof AUTO_FRAME_RATE_MODES)[number];

/** Supported Android Night-Mode dynamic range compression (DRC) presets (`#115`). */
export const NIGHT_MODE_DRC_PRESETS = ['off', 'light', 'night'] as const;

/** User-selectable Night-Mode DRC preset (`#115`). */
export type NightModeDrcPreset = (typeof NIGHT_MODE_DRC_PRESETS)[number];

/** Canonical broadcast/cinema refresh-rate buckets for per-refresh-rate A/V delay (`#115`). */
export const REFRESH_RATE_BUCKETS = [
  '23.976',
  '24',
  '25',
  '29.97',
  '30',
  '50',
  '59.94',
  '60',
] as const;

/** Canonical refresh-rate bucket key (`#115`). */
export type RefreshRateBucket = (typeof REFRESH_RATE_BUCKETS)[number];

/** Minimum per-refresh-rate audio delay offset in milliseconds (`#115`). */
export const MIN_REFRESH_RATE_AUDIO_DELAY_MS = -1000;

/** Maximum per-refresh-rate audio delay offset in milliseconds (`#115`). */
export const MAX_REFRESH_RATE_AUDIO_DELAY_MS = 1000;

/** Supported desktop bitstream audio passthrough codecs (`#213`). */
export const AUDIO_PASSTHROUGH_CODECS = ['ac3', 'eac3', 'dts', 'dts-hd', 'truehd'] as const;

/** User-selectable desktop bitstream audio passthrough codec (`#213`). */
export type AudioPassthroughCodec = (typeof AUDIO_PASSTHROUGH_CODECS)[number];

/** Default allowlist of desktop audio passthrough codecs (`#213`). */
export const DEFAULT_AUDIO_PASSTHROUGH_CODECS: readonly AudioPassthroughCodec[] = Object.freeze([
  'ac3',
  'eac3',
  'dts',
]);

/** Supported desktop audio channel layout targets (`#213`). */
export const AUDIO_CHANNEL_LAYOUTS = ['auto', 'stereo', '5.1', '7.1'] as const;

/** User-selectable desktop audio channel layout (`#213`). */
export type AudioChannelLayout = (typeof AUDIO_CHANNEL_LAYOUTS)[number];

/** Wave F7A display sync, night-mode DRC, per-refresh-rate delay, and desktop audio preferences. */
export interface WaveF7aPreferencesFields {
  readonly autoFrameRate: AutoFrameRateMode;
  readonly autoDynamicRange: boolean;
  readonly nightModeDrc: NightModeDrcPreset;
  readonly audioDelayByRefreshRateMs: Readonly<Partial<Record<RefreshRateBucket, number>>>;
  readonly audioPassthrough: boolean;
  readonly audioPassthroughCodecs: readonly AudioPassthroughCodec[];
  readonly audioExclusive: boolean;
  readonly audioAc3Encode: boolean;
  readonly audioChannelLayout: AudioChannelLayout;
}

/** Default values for all Wave F7A preference fields. */
export const DEFAULT_WAVE_F7A_PREFERENCES: WaveF7aPreferencesFields = Object.freeze({
  autoFrameRate: 'seamless',
  autoDynamicRange: true,
  nightModeDrc: 'off',
  audioDelayByRefreshRateMs: Object.freeze({}),
  audioPassthrough: false,
  audioPassthroughCodecs: DEFAULT_AUDIO_PASSTHROUGH_CODECS,
  audioExclusive: false,
  audioAc3Encode: false,
  audioChannelLayout: 'auto',
});

/** Returns true when `value` is a supported {@link AutoFrameRateMode}. */
export function isAutoFrameRateMode(value: unknown): value is AutoFrameRateMode {
  return typeof value === 'string' && (AUTO_FRAME_RATE_MODES as readonly string[]).includes(value);
}

/** Returns true when `value` is a supported {@link NightModeDrcPreset}. */
export function isNightModeDrcPreset(value: unknown): value is NightModeDrcPreset {
  return typeof value === 'string' && (NIGHT_MODE_DRC_PRESETS as readonly string[]).includes(value);
}

/** Returns true when `value` is a canonical {@link RefreshRateBucket}. */
export function isRefreshRateBucket(value: unknown): value is RefreshRateBucket {
  return typeof value === 'string' && (REFRESH_RATE_BUCKETS as readonly string[]).includes(value);
}

/** Returns true when `value` is a supported {@link AudioPassthroughCodec}. */
export function isAudioPassthroughCodec(value: unknown): value is AudioPassthroughCodec {
  return (
    typeof value === 'string' && (AUDIO_PASSTHROUGH_CODECS as readonly string[]).includes(value)
  );
}

/** Returns true when `value` is a supported {@link AudioChannelLayout}. */
export function isAudioChannelLayout(value: unknown): value is AudioChannelLayout {
  return typeof value === 'string' && (AUDIO_CHANNEL_LAYOUTS as readonly string[]).includes(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Normalizes a per-refresh-rate audio delay map: allowlist keys, finite ints clamped `[-1000, 1000]`, omits `0`. */
export function normalizeAudioDelayByRefreshRateMs(
  value: unknown,
): Readonly<Partial<Record<RefreshRateBucket, number>>> {
  if (!isPlainRecord(value)) return DEFAULT_WAVE_F7A_PREFERENCES.audioDelayByRefreshRateMs;
  const out: Partial<Record<RefreshRateBucket, number>> = {};
  for (const bucket of REFRESH_RATE_BUCKETS) {
    if (!Object.hasOwn(value, bucket)) continue;
    const raw = value[bucket];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const clamped = Math.round(
      Math.min(MAX_REFRESH_RATE_AUDIO_DELAY_MS, Math.max(MIN_REFRESH_RATE_AUDIO_DELAY_MS, raw)),
    );
    if (clamped === 0) continue;
    out[bucket] = clamped;
  }
  return Object.freeze(out);
}

/** Normalizes a desktop passthrough codec list to a deduplicated allowlist. */
export function normalizeAudioPassthroughCodecs(
  value: unknown,
  fallback: readonly AudioPassthroughCodec[] = DEFAULT_AUDIO_PASSTHROUGH_CODECS,
): readonly AudioPassthroughCodec[] {
  if (!Array.isArray(value)) return fallback;
  const out: AudioPassthroughCodec[] = [];
  const seen = new Set<AudioPassthroughCodec>();
  for (const item of value) {
    if (!isAudioPassthroughCodec(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return Object.freeze(out);
}

export function parseWaveF7aPreferences(
  parsed: Record<string, unknown>,
  defaults: WaveF7aPreferencesFields,
): WaveF7aPreferencesFields {
  return {
    autoFrameRate: isAutoFrameRateMode(parsed.autoFrameRate)
      ? parsed.autoFrameRate
      : defaults.autoFrameRate,
    autoDynamicRange: boolOr(parsed.autoDynamicRange, defaults.autoDynamicRange),
    nightModeDrc: isNightModeDrcPreset(parsed.nightModeDrc)
      ? parsed.nightModeDrc
      : defaults.nightModeDrc,
    audioDelayByRefreshRateMs: normalizeAudioDelayByRefreshRateMs(parsed.audioDelayByRefreshRateMs),
    audioPassthrough: boolOr(parsed.audioPassthrough, defaults.audioPassthrough),
    audioPassthroughCodecs: normalizeAudioPassthroughCodecs(
      parsed.audioPassthroughCodecs,
      defaults.audioPassthroughCodecs,
    ),
    audioExclusive: boolOr(parsed.audioExclusive, defaults.audioExclusive),
    audioAc3Encode: boolOr(parsed.audioAc3Encode, defaults.audioAc3Encode),
    audioChannelLayout: isAudioChannelLayout(parsed.audioChannelLayout)
      ? parsed.audioChannelLayout
      : defaults.audioChannelLayout,
  };
}

function sameCodecList(
  a: readonly AudioPassthroughCodec[],
  b: readonly AudioPassthroughCodec[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function serializeWaveF7aPreferences(
  snapshot: WaveF7aPreferencesFields,
  defaults: WaveF7aPreferencesFields,
): Partial<WaveF7aPreferencesFields> {
  const autoFrameRate = isAutoFrameRateMode(snapshot.autoFrameRate)
    ? snapshot.autoFrameRate
    : defaults.autoFrameRate;
  const autoDynamicRange = Boolean(snapshot.autoDynamicRange);
  const nightModeDrc = isNightModeDrcPreset(snapshot.nightModeDrc)
    ? snapshot.nightModeDrc
    : defaults.nightModeDrc;
  const audioDelayByRefreshRateMs = normalizeAudioDelayByRefreshRateMs(
    snapshot.audioDelayByRefreshRateMs,
  );
  const audioPassthrough = Boolean(snapshot.audioPassthrough);
  const audioPassthroughCodecs = normalizeAudioPassthroughCodecs(
    snapshot.audioPassthroughCodecs,
    defaults.audioPassthroughCodecs,
  );
  const audioExclusive = Boolean(snapshot.audioExclusive);
  const audioAc3Encode = Boolean(snapshot.audioAc3Encode);
  const audioChannelLayout = isAudioChannelLayout(snapshot.audioChannelLayout)
    ? snapshot.audioChannelLayout
    : defaults.audioChannelLayout;

  return {
    ...(autoFrameRate === defaults.autoFrameRate ? {} : { autoFrameRate }),
    ...(autoDynamicRange === defaults.autoDynamicRange ? {} : { autoDynamicRange }),
    ...(nightModeDrc === defaults.nightModeDrc ? {} : { nightModeDrc }),
    ...(Object.keys(audioDelayByRefreshRateMs).length === 0 ? {} : { audioDelayByRefreshRateMs }),
    ...(audioPassthrough === defaults.audioPassthrough ? {} : { audioPassthrough }),
    ...(sameCodecList(audioPassthroughCodecs, defaults.audioPassthroughCodecs)
      ? {}
      : { audioPassthroughCodecs }),
    ...(audioExclusive === defaults.audioExclusive ? {} : { audioExclusive }),
    ...(audioAc3Encode === defaults.audioAc3Encode ? {} : { audioAc3Encode }),
    ...(audioChannelLayout === defaults.audioChannelLayout ? {} : { audioChannelLayout }),
  };
}

export function mergeWaveF7aPreferences(
  base: WaveF7aPreferencesFields,
  patch: Partial<WaveF7aPreferencesFields>,
): WaveF7aPreferencesFields {
  return {
    autoFrameRate: isAutoFrameRateMode(patch.autoFrameRate)
      ? patch.autoFrameRate
      : base.autoFrameRate,
    autoDynamicRange: boolOr(patch.autoDynamicRange, base.autoDynamicRange),
    nightModeDrc: isNightModeDrcPreset(patch.nightModeDrc) ? patch.nightModeDrc : base.nightModeDrc,
    audioDelayByRefreshRateMs: isPlainRecord(patch.audioDelayByRefreshRateMs)
      ? normalizeAudioDelayByRefreshRateMs(patch.audioDelayByRefreshRateMs)
      : base.audioDelayByRefreshRateMs,
    audioPassthrough: boolOr(patch.audioPassthrough, base.audioPassthrough),
    audioPassthroughCodecs: Array.isArray(patch.audioPassthroughCodecs)
      ? normalizeAudioPassthroughCodecs(patch.audioPassthroughCodecs, base.audioPassthroughCodecs)
      : base.audioPassthroughCodecs,
    audioExclusive: boolOr(patch.audioExclusive, base.audioExclusive),
    audioAc3Encode: boolOr(patch.audioAc3Encode, base.audioAc3Encode),
    audioChannelLayout: isAudioChannelLayout(patch.audioChannelLayout)
      ? patch.audioChannelLayout
      : base.audioChannelLayout,
  };
}
