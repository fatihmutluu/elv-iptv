import { normalizeMaxConnections, resolveAccountPoolKey, type SourceRow } from '@elv/data';
import type { KeyEvent } from '@elv/focus-core';
import type { AppI18n } from '@elv/i18n';
import type {
  MultiViewAddResult,
  MultiViewAddTileInput,
  MultiViewDeviceCapabilities,
  MultiViewTileStatus,
  PlaybackStatus,
} from '@elv/playback';
import type { PlayableEntry } from '../ports/play-target';
import type { ThermalDevicePort, VideoHost } from '../ports/video-host';

/** Inline Cinema Quietude banner shown in Multi-View for connection or thermal gates (`#221`, `#232`). */
export type MultiViewBanner =
  | { readonly kind: 'connection-limit'; readonly active: number; readonly max: number }
  | { readonly kind: 'thermal-serious' }
  | { readonly kind: 'thermal-critical'; readonly shedCount: number }
  | { readonly kind: 'device-cap'; readonly max: number }
  | { readonly kind: 'low-ram' };

/** Computed grid dimensions for Multi-View `16:9` tiles. */
export interface MultiViewGridLayout {
  readonly columns: 2;
  readonly rows: 1 | 2;
  readonly showEmptySlot: boolean;
}

/** Resolves effective hardware Multi-View capabilities from optional {@link ThermalDevicePort} and {@link VideoHost}. */
export function resolveMultiViewCapabilities(
  thermalDevice: ThermalDevicePort | undefined,
  videoHost: Pick<VideoHost, 'supportsMultiView'>,
): MultiViewDeviceCapabilities {
  if (thermalDevice !== undefined) {
    const caps = thermalDevice.getMultiViewCapabilities();
    return {
      ...caps,
      ...(videoHost.supportsMultiView === false ? { supported: false } : {}),
    };
  }
  return {
    platform: 'desktop',
    supported: videoHost.supportsMultiView === true,
  };
}

/** Builds a {@link MultiViewAddTileInput} enriched with per-account pool key and `maxConnections` (`#221`). */
export function buildMultiViewTileInput(
  entry: PlayableEntry,
  sources: readonly SourceRow[],
): MultiViewAddTileInput {
  const source = sources.find((s) => s.id === entry.sourceId);
  const accountKey =
    entry.accountKey ?? (source !== undefined ? resolveAccountPoolKey(source) : entry.sourceId);
  const maxConnections = normalizeMaxConnections(source?.accountMeta?.maxConnections);
  const providerActiveCons = source?.accountMeta?.activeConnections;
  return {
    itemKey: entry.itemKey,
    title: entry.title,
    sourceId: entry.sourceId,
    accountKey,
    maxConnections,
    ...(entry.logo !== undefined && entry.logo !== null ? { logo: entry.logo } : {}),
    ...(providerActiveCons !== undefined ? { providerActiveCons } : {}),
  };
}

/** Maps a rejected {@link MultiViewAddResult} to an inline Cinema Quietude {@link MultiViewBanner}. */
export function mapAddFailureToBanner(
  result: Extract<MultiViewAddResult, { ok: false }>,
): MultiViewBanner | null {
  switch (result.reason) {
    case 'connection-limit':
      return {
        kind: 'connection-limit',
        active: result.activeCount ?? 1,
        max: result.maxConnections ?? 1,
      };
    case 'thermal-serious':
      return { kind: 'thermal-serious' };
    case 'thermal-critical':
      return { kind: 'thermal-critical', shedCount: 0 };
    case 'device-tile-cap':
      return { kind: 'device-cap', max: result.hardwareMaxTiles ?? 2 };
    case 'low-ram':
    case 'unsupported':
      return { kind: 'low-ram' };
    default:
      return null;
  }
}

/** Formats localized title/body and visual tone for a {@link MultiViewBanner}. */
export function formatMultiViewBannerText(
  banner: MultiViewBanner,
  i18n: Pick<AppI18n, 't'>,
): { readonly title: string; readonly body?: string; readonly tone: 'warning' | 'danger' } {
  switch (banner.kind) {
    case 'connection-limit':
      return {
        title: i18n.t('player.multiView.connectionLimitTitle'),
        body: i18n.t('player.multiView.connectionLimitBody', {
          active: banner.active,
          max: banner.max,
        }),
        tone: 'warning',
      };
    case 'thermal-serious':
      return {
        title: i18n.t('player.multiView.thermalSerious'),
        tone: 'warning',
      };
    case 'thermal-critical':
      return {
        title: i18n.t('player.multiView.thermalCriticalShed'),
        tone: 'danger',
      };
    case 'device-cap':
      return {
        title: i18n.t('player.multiView.deviceCapReached', { max: banner.max }),
        tone: 'warning',
      };
    case 'low-ram':
      return {
        title: i18n.t('player.multiView.lowRamUnsupported'),
        tone: 'warning',
      };
  }
}

/** Computes `16:9` Multi-View grid rows/columns and whether to render an inline empty add slot. */
export function computeMultiViewGridLayout(
  tileCount: number,
  effectiveMaxTiles: number,
  canAddTile: boolean,
): MultiViewGridLayout {
  const showEmptySlot = canAddTile && tileCount < effectiveMaxTiles;
  const renderedSlots = tileCount + (showEmptySlot ? 1 : 0);
  const rows: 1 | 2 = renderedSlots > 2 ? 2 : 1;
  return { columns: 2, rows, showEmptySlot };
}

/** Maps a `PlaybackStatus['kind']` to {@link MultiViewTileStatus}. */
export function mapPlaybackStatusToTileStatus(kind: PlaybackStatus['kind']): MultiViewTileStatus {
  switch (kind) {
    case 'playing':
      return 'playing';
    case 'paused':
    case 'ended':
      return 'paused';
    case 'failed':
      return 'error';
    default:
      return 'loading';
  }
}

/** Moves TV 2D grid focus across a 2-column Multi-View grid. */
export function moveMultiViewGridFocus(
  currentIndex: number,
  slotCount: number,
  key: KeyEvent['key'],
): number {
  if (slotCount <= 0) return 0;
  const clamped = Math.max(0, Math.min(slotCount - 1, currentIndex));
  if (key === 'right') return Math.min(slotCount - 1, clamped + 1);
  if (key === 'left') return Math.max(0, clamped - 1);
  if (key === 'down') return Math.min(slotCount - 1, clamped + 2);
  if (key === 'up') return Math.max(0, clamped - 2);
  return clamped;
}

/** Inline tile actions reachable via TV D-pad action focus mode (`#34`). */
export type MultiViewTileAction = 'audio' | 'replace' | 'remove';

/** Ordered inline tile actions rendered for a Multi-View tile (`Swap Audio` omitted on the active-audio tile). */
export function getMultiViewTileActions(isActiveAudio: boolean): readonly MultiViewTileAction[] {
  return isActiveAudio ? ['replace', 'remove'] : ['audio', 'replace', 'remove'];
}

/** Moves TV D-pad focus horizontally within a tile's inline action bar. */
export function moveMultiViewTileActionFocus(
  currentIndex: number,
  actionCount: number,
  key: KeyEvent['key'],
): number {
  if (actionCount <= 0) return 0;
  const clamped = Math.max(0, Math.min(actionCount - 1, currentIndex));
  if (key === 'right') return Math.min(actionCount - 1, clamped + 1);
  if (key === 'left') return Math.max(0, clamped - 1);
  return clamped;
}
