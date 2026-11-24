import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

const MAX_CHANNELS = 2;
const MAX_PROGRAMS_PER_CHANNEL = 20;
const MAX_ITEM_KEY_CHARS = 512;

const ALLOWED_KINDS = new Set<string>(['live', 'movie', 'episode']);
const ALLOWED_CHANNEL_IDS = new Set<string>(['continue_watching', 'favorites']);

const UNSUPPORTED_SYNC_RESULT: TvHomeChannelsSyncResult = {
  supported: false,
  syncedChannels: 0,
  syncedPrograms: 0,
};

/** One preview program card published inside an Android TV home screen channel (`#273`). */
export interface TvHomeProgramInput {
  readonly itemKey: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly kind: 'live' | 'movie' | 'episode';
  readonly logoUrl?: string;
  readonly durationMs?: number;
  readonly lastPlaybackPositionMs?: number;
  readonly isLive?: boolean;
}

/** One bounded Android TV home screen preview channel (`#273`). */
export interface TvHomeChannelInput {
  readonly internalId: 'continue_watching' | 'favorites';
  readonly displayName: string;
  readonly isDefaultBrowsable?: boolean;
  readonly programs: readonly TvHomeProgramInput[];
}

/** Result returned after syncing preview channels to the Android TV launcher (`#273`). */
export interface TvHomeChannelsSyncResult {
  readonly supported: boolean;
  readonly syncedChannels: number;
  readonly syncedPrograms: number;
}

interface NativeTvHomeChannels {
  isSupported(): boolean;
  syncChannels(channels: readonly TvHomeChannelInput[]): Promise<unknown>;
  clearChannels(): Promise<void>;
}

function getNativeModule(): NativeTvHomeChannels | null {
  if (Platform.OS !== 'android') return null;
  return requireOptionalNativeModule<NativeTvHomeChannels>('ElvTvHomeChannels');
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isValidItemKey(itemKey: string): boolean {
  return (
    typeof itemKey === 'string' &&
    itemKey.length > 0 &&
    itemKey.length <= MAX_ITEM_KEY_CHARS &&
    itemKey.trim().length > 0 &&
    !hasControlChar(itemKey)
  );
}

/**
 * Builds the canonical `elviptv://play` deep-link URI for a TV launcher program card.
 * Encodes only the opaque catalog `itemKey` and playback `kind` — never stream URLs or credentials.
 */
export function buildTvPlayDeepLink(itemKey: string, kind: 'live' | 'movie' | 'episode'): string {
  if (!isValidItemKey(itemKey)) {
    throw new Error('itemKey must be a non-empty string without control characters');
  }
  if (!ALLOWED_KINDS.has(kind)) {
    throw new Error(`Unsupported TV deep-link kind: ${String(kind)}`);
  }
  return `elviptv://play?key=${encodeURIComponent(itemKey)}&kind=${kind}`;
}

function sanitizeProgram(program: TvHomeProgramInput): TvHomeProgramInput | null {
  if (!isValidItemKey(program.itemKey) || !ALLOWED_KINDS.has(program.kind)) return null;
  const title = typeof program.title === 'string' ? program.title.trim() : '';
  if (title.length === 0) return null;

  const subtitle =
    typeof program.subtitle === 'string' && program.subtitle.trim().length > 0
      ? program.subtitle.trim()
      : undefined;
  const logoUrl =
    typeof program.logoUrl === 'string' && program.logoUrl.trim().length > 0
      ? program.logoUrl.trim()
      : undefined;
  const durationMs =
    typeof program.durationMs === 'number' &&
    Number.isFinite(program.durationMs) &&
    program.durationMs > 0
      ? Math.floor(program.durationMs)
      : undefined;
  const lastPlaybackPositionMs =
    typeof program.lastPlaybackPositionMs === 'number' &&
    Number.isFinite(program.lastPlaybackPositionMs) &&
    program.lastPlaybackPositionMs >= 0
      ? Math.floor(program.lastPlaybackPositionMs)
      : undefined;

  return {
    itemKey: program.itemKey,
    title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    kind: program.kind,
    ...(logoUrl !== undefined ? { logoUrl } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(lastPlaybackPositionMs !== undefined ? { lastPlaybackPositionMs } : {}),
    ...(program.isLive !== undefined ? { isLive: Boolean(program.isLive) } : {}),
  };
}

function sanitizeChannels(channels: readonly TvHomeChannelInput[]): TvHomeChannelInput[] {
  const seen = new Set<string>();
  const out: TvHomeChannelInput[] = [];

  for (const channel of channels) {
    if (out.length >= MAX_CHANNELS) break;
    if (!ALLOWED_CHANNEL_IDS.has(channel.internalId) || seen.has(channel.internalId)) continue;
    const displayName = typeof channel.displayName === 'string' ? channel.displayName.trim() : '';
    if (displayName.length === 0) continue;

    seen.add(channel.internalId);
    const programs: TvHomeProgramInput[] = [];
    for (const program of channel.programs) {
      if (programs.length >= MAX_PROGRAMS_PER_CHANNEL) break;
      const sanitized = sanitizeProgram(program);
      if (sanitized !== null) programs.push(sanitized);
    }

    out.push({
      internalId: channel.internalId,
      displayName,
      ...(channel.isDefaultBrowsable !== undefined
        ? { isDefaultBrowsable: Boolean(channel.isDefaultBrowsable) }
        : {}),
      programs,
    });
  }

  return out;
}

function normalizeNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function parseSyncResult(raw: unknown): TvHomeChannelsSyncResult {
  if (typeof raw !== 'object' || raw === null) return UNSUPPORTED_SYNC_RESULT;
  const rec = raw as Record<string, unknown>;
  return {
    supported: Boolean(rec.supported),
    syncedChannels: normalizeNonNegativeInt(rec.syncedChannels),
    syncedPrograms: normalizeNonNegativeInt(rec.syncedPrograms),
  };
}

/** Returns whether Android TV Home Screen Preview Channels are supported on this device. */
export function isTvHomeChannelsSupported(): boolean {
  const native = getNativeModule();
  if (native === null || typeof native.isSupported !== 'function') return false;
  try {
    return Boolean(native.isSupported());
  } catch {
    return false;
  }
}

/**
 * Syncs up to 2 bounded preview channels (`continue_watching`, `favorites`, max 20 programs each)
 * to the Android TV home screen. Safe no-op on non-Android platforms or missing native builds.
 */
export async function syncTvHomeChannels(
  channels: readonly TvHomeChannelInput[],
): Promise<TvHomeChannelsSyncResult> {
  const native = getNativeModule();
  if (native === null || typeof native.syncChannels !== 'function') {
    return UNSUPPORTED_SYNC_RESULT;
  }
  const bounded = sanitizeChannels(channels);
  const raw = await native.syncChannels(bounded);
  return parseSyncResult(raw);
}

/**
 * Removes all app-owned Android TV home screen channels and clears cached launcher logos.
 * Safe no-op on non-Android platforms or missing native builds.
 */
export async function clearTvHomeChannels(): Promise<void> {
  const native = getNativeModule();
  if (native === null || typeof native.clearChannels !== 'function') return;
  await native.clearChannels();
}
