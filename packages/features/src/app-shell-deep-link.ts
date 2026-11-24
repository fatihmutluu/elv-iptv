import type { CatalogService, ItemDetailRow } from '@elv/data';
import { useEffect, useRef } from 'react';
import type { PlayDeepLinkTarget } from './ports/play-deep-link';
import type { PlayTarget } from './ports/play-target';
import { type DetailTarget, detailTargetFromItem, type ProfileContextValue } from './shared';

/** Result of resolving a deep-link item detail into an actionable playback or detail target. */
export type ResolvedDeepLinkAction =
  | { readonly kind: 'play'; readonly target: PlayTarget }
  | { readonly kind: 'detail'; readonly target: DetailTarget };

/**
 * Converts a resolved {@link ItemDetailRow} into a play-time {@link PlayTarget} (for live channels
 * and movies) or a {@link DetailTarget} (for series). Stream URLs are never embedded; playback
 * resolves streams strictly at play time via `CatalogService.resolveStream`.
 */
export function resolveDeepLinkActionFromDetail(
  detail: ItemDetailRow,
  requestedKind?: PlayDeepLinkTarget['kind'],
): ResolvedDeepLinkAction {
  if (detail.kind === 'live') {
    return {
      kind: 'play',
      target: {
        kind: 'live',
        itemKey: detail.key,
        sourceId: detail.sourceId,
        title: detail.name,
        ...(detail.logo ? { logo: detail.logo } : {}),
        ...(detail.num !== null ? { channelNumber: detail.num } : {}),
      },
    };
  }
  if (detail.kind === 'series' && requestedKind !== 'episode') {
    const dt = detailTargetFromItem(detail);
    if (dt !== undefined) {
      return {
        kind: 'detail',
        target: dt,
      };
    }
  }
  return {
    kind: 'play',
    target: {
      kind: 'vod',
      itemKey: detail.key,
      sourceId: detail.sourceId,
      title: detail.name,
      ...(detail.logo ? { logo: detail.logo } : {}),
    },
  };
}

/**
 * Builds a fallback VOD {@link PlayTarget} for episode deep links (`elviptv://play?key=...&kind=episode`)
 * whose key lives in the `episodes` table rather than `live`/`movies`/`series`.
 */
export function buildEpisodeDeepLinkPlayTarget(
  target: PlayDeepLinkTarget,
  fallbackTitle: string,
): PlayTarget | null {
  const parts = target.itemKey.split(':');
  const sourceId = parts[1];
  if (!sourceId || sourceId.trim().length === 0) return null;
  return {
    kind: 'vod',
    itemKey: target.itemKey,
    sourceId,
    title: fallbackTitle,
  };
}

/** Options accepted by {@link usePlayDeepLinkHandler}. */
export interface UsePlayDeepLinkHandlerOptions {
  readonly catalog: CatalogService;
  readonly profile: ProfileContextValue;
  readonly pendingDeepLink?: PlayDeepLinkTarget | null;
  readonly onPlay: (target: PlayTarget) => void;
  readonly onOpenDetail: (target: DetailTarget) => void;
  readonly onDeepLinkHandled?: () => void;
}

/**
 * Consumes incoming `elviptv://play?key=...` deep links once profiles are ready (`#273`).
 * Honors active profile and parental locks: if an item is blocked by parental controls and a PIN
 * is configured, prompts for parental unlock before launching playback.
 */
export function usePlayDeepLinkHandler({
  catalog,
  profile,
  pendingDeepLink,
  onPlay,
  onOpenDetail,
  onDeepLinkHandled,
}: UsePlayDeepLinkHandlerOptions): void {
  const handledRef = useRef<PlayDeepLinkTarget | null>(null);
  const callbacksRef = useRef({ onPlay, onOpenDetail, onDeepLinkHandled });
  callbacksRef.current = { onPlay, onOpenDetail, onDeepLinkHandled };
  const profileRef = useRef(profile);
  profileRef.current = profile;

  useEffect(() => {
    if (pendingDeepLink === undefined || pendingDeepLink === null) {
      handledRef.current = null;
      return undefined;
    }
    if (!profile.profilesReady) return undefined;
    if (handledRef.current === pendingDeepLink) return undefined;
    handledRef.current = pendingDeepLink;

    let cancelled = false;

    const dispatchAction = (action: ResolvedDeepLinkAction): void => {
      if (action.kind === 'play') callbacksRef.current.onPlay(action.target);
      else callbacksRef.current.onOpenDetail(action.target);
    };

    const consume = async () => {
      try {
        const detail = catalog.itemDetail
          ? await catalog.itemDetail(pendingDeepLink.itemKey).catch(() => null)
          : null;
        if (cancelled) return;

        if (detail !== null) {
          dispatchAction(resolveDeepLinkActionFromDetail(detail, pendingDeepLink.kind));
          return;
        }

        const currentProfile = profileRef.current;
        const canPromptParental =
          !currentProfile.parentalUnlocked &&
          (currentProfile.parentalSettings.enabled || currentProfile.activeProfile.isKids) &&
          currentProfile.hasGuardPin;

        if (canPromptParental && catalog.itemDetail) {
          const lockedDetail = await catalog
            .itemDetail(pendingDeepLink.itemKey, { parentalUnlocked: true })
            .catch(() => null);
          if (cancelled) return;
          if (lockedDetail !== null) {
            currentProfile.requestParentalUnlock(() => {
              dispatchAction(resolveDeepLinkActionFromDetail(lockedDetail, pendingDeepLink.kind));
            });
            return;
          }
        }

        if (pendingDeepLink.kind === 'episode') {
          const progress = catalog.getProgress
            ? await catalog.getProgress(pendingDeepLink.itemKey).catch(() => null)
            : null;
          if (cancelled) return;
          const resolved = await catalog.resolveStream(pendingDeepLink.itemKey).catch(() => null);
          if (cancelled) return;
          if (resolved !== null && !resolved.ok && resolved.error.code === 'parental-locked') {
            if (canPromptParental) {
              const target = buildEpisodeDeepLinkPlayTarget(
                pendingDeepLink,
                progress?.title ?? pendingDeepLink.itemKey,
              );
              if (target !== null) {
                currentProfile.requestParentalUnlock(() => {
                  callbacksRef.current.onPlay(target);
                });
              }
            }
            return;
          }
          if (resolved?.ok) {
            const target = buildEpisodeDeepLinkPlayTarget(
              pendingDeepLink,
              progress?.title ?? pendingDeepLink.itemKey,
            );
            if (target !== null) callbacksRef.current.onPlay(target);
          }
        }
      } finally {
        if (!cancelled) {
          callbacksRef.current.onDeepLinkHandled?.();
        }
      }
    };

    void consume();

    return () => {
      cancelled = true;
    };
  }, [catalog, pendingDeepLink, profile.profilesReady]);
}
