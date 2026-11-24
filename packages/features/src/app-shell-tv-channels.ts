import type { CatalogService, FavoriteRow, UserItemKind, WatchProgressRow } from '@elv/data';
import { useEffect, useRef } from 'react';
import type {
  TvHomeChannelDescriptor,
  TvHomeChannelProgram,
  TvHomeChannelsPort,
  TvHomeProgramKind,
} from './ports/tv-home-channels';

/** Maximum number of preview programs synced per Android TV Home Screen channel (`#273`). */
export const TV_HOME_CHANNELS_MAX_PROGRAMS = 20;

/** Default debounce delay (ms) coalescing rapid catalog/progress updates before native sync. */
export const TV_HOME_CHANNELS_SYNC_DEBOUNCE_MS = 350;

function toTvHomeProgramKind(kind: UserItemKind): TvHomeProgramKind | null {
  if (kind === 'live' || kind === 'movie' || kind === 'episode') return kind;
  return null;
}

function normalizeLogoUrl(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Projects parental-filtered `WatchProgressRow` and `FavoriteRow` lists into bounded Android TV
 * Home Screen preview channel descriptors (`#273`).
 *
 * Security invariant: NEVER includes raw stream URLs, credentials, or hostnames — only catalog
 * `itemKey`, title, subtitle, kind, public logo URL, duration, and playback position.
 */
export function buildTvHomeChannelsPayload(input: {
  readonly continueWatching: readonly WatchProgressRow[];
  readonly favorites: readonly FavoriteRow[];
  readonly continueWatchingLabel: string;
  readonly favoritesLabel: string;
  readonly maxPrograms?: number;
}): readonly TvHomeChannelDescriptor[] {
  const cap = Math.max(1, Math.min(TV_HOME_CHANNELS_MAX_PROGRAMS, input.maxPrograms ?? 20));
  const continuePrograms: TvHomeChannelProgram[] = [];
  for (const row of input.continueWatching) {
    if (continuePrograms.length >= cap) break;
    const kind = toTvHomeProgramKind(row.kind);
    if (kind === null || row.watched) continue;
    const title = row.title.trim();
    if (title.length === 0) continue;
    const subtitle = row.subtitle?.trim();
    const logoUrl = normalizeLogoUrl(row.logo);
    continuePrograms.push({
      itemKey: row.itemKey,
      title,
      ...(subtitle && subtitle.length > 0 ? { subtitle } : {}),
      kind,
      ...(logoUrl !== undefined ? { logoUrl } : {}),
      ...(row.durationMs > 0 ? { durationMs: Math.round(row.durationMs) } : {}),
      ...(row.positionMs > 0 ? { lastPlaybackPositionMs: Math.round(row.positionMs) } : {}),
      isLive: kind === 'live',
    });
  }

  const favoritePrograms: TvHomeChannelProgram[] = [];
  for (const row of input.favorites) {
    if (favoritePrograms.length >= cap) break;
    const kind = toTvHomeProgramKind(row.kind);
    if (kind === null) continue;
    const title = row.title.trim();
    if (title.length === 0) continue;
    const logoUrl = normalizeLogoUrl(row.logo);
    favoritePrograms.push({
      itemKey: row.itemKey,
      title,
      kind,
      ...(logoUrl !== undefined ? { logoUrl } : {}),
      isLive: kind === 'live',
    });
  }

  return [
    {
      internalId: 'continue_watching',
      displayName: input.continueWatchingLabel,
      isDefaultBrowsable: true,
      programs: continuePrograms,
    },
    {
      internalId: 'favorites',
      displayName: input.favoritesLabel,
      isDefaultBrowsable: true,
      programs: favoritePrograms,
    },
  ];
}

/** Computes a deterministic content signature to skip redundant Android TV Home Screen syncs. */
export function computeTvHomeChannelsSignature(
  channels: readonly TvHomeChannelDescriptor[],
): string {
  return JSON.stringify(
    channels.map((ch) => [
      ch.internalId,
      ch.displayName,
      ch.programs.map((p) => [
        p.itemKey,
        p.title,
        p.subtitle ?? '',
        p.kind,
        p.logoUrl ?? '',
        p.durationMs ?? 0,
        p.lastPlaybackPositionMs ?? 0,
        p.isLive ? 1 : 0,
      ]),
    ]),
  );
}

/** Options accepted by {@link useTvHomeChannelsSync}. */
export interface UseTvHomeChannelsSyncOptions {
  /** Profile-scoped catalog (`createProfileScopedCatalog`) so Kids / parental locks are enforced. */
  readonly catalog: CatalogService;
  readonly tvHomeChannels?: TvHomeChannelsPort;
  readonly profilesReady: boolean;
  readonly syncKey: string;
  readonly continueWatchingLabel: string;
  readonly favoritesLabel: string;
  readonly debounceMs?: number;
}

/**
 * Throttled, idempotent Android TV Home Screen preview channels synchronizer (`#273`).
 * Queries parental-filtered `listContinueWatching(20)` and `listFavorites(20)` through the
 * profile-scoped catalog so locked or adult content never leaks onto the Android TV launcher.
 */
export function useTvHomeChannelsSync({
  catalog,
  tvHomeChannels,
  profilesReady,
  syncKey,
  continueWatchingLabel,
  favoritesLabel,
  debounceMs = TV_HOME_CHANNELS_SYNC_DEBOUNCE_MS,
}: UseTvHomeChannelsSyncOptions): void {
  const lastSignatureRef = useRef<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    void syncKey;
    if (!profilesReady || !tvHomeChannels?.isSupported()) return undefined;
    let cancelled = false;
    const seq = ++seqRef.current;

    const runSync = async () => {
      try {
        const [continueWatching, favorites] = await Promise.all([
          catalog.listContinueWatching
            ? catalog.listContinueWatching(TV_HOME_CHANNELS_MAX_PROGRAMS).catch(() => [])
            : Promise.resolve([]),
          catalog.listFavorites
            ? catalog.listFavorites(TV_HOME_CHANNELS_MAX_PROGRAMS).catch(() => [])
            : Promise.resolve([]),
        ]);
        if (cancelled || seqRef.current !== seq) return;
        const payload = buildTvHomeChannelsPayload({
          continueWatching,
          favorites,
          continueWatchingLabel,
          favoritesLabel,
        });
        const signature = computeTvHomeChannelsSignature(payload);
        if (signature === lastSignatureRef.current) return;
        await tvHomeChannels.syncChannels(payload);
        if (!cancelled && seqRef.current === seq) {
          lastSignatureRef.current = signature;
        }
      } catch {
        // Best-effort launcher sync; never disrupt foreground playback or UI.
      }
    };

    if (debounceMs <= 0) {
      void runSync();
      return () => {
        cancelled = true;
      };
    }

    const timer = setTimeout(() => {
      void runSync();
    }, debounceMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    catalog,
    continueWatchingLabel,
    debounceMs,
    favoritesLabel,
    profilesReady,
    syncKey,
    tvHomeChannels,
  ]);
}
