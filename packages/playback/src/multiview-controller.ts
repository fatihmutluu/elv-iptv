import type { ConnectionTracker } from './connection-tracker';
import {
  evaluateMultiViewThermalPolicy,
  type MultiViewDeviceCapabilities,
  normalizeThermalState,
  resolveHardwareMultiViewCap,
  type ThermalState,
} from './thermal-watchdog';

/** Playback lifecycle status for a single Multi-View tile. */
export type MultiViewTileStatus = 'loading' | 'playing' | 'paused' | 'error';

/** Immutable snapshot of a single active Multi-View tile (`#34`, `#221`, `#232`). */
export interface MultiViewTile {
  readonly tileId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly sourceId: string;
  readonly accountKey: string;
  readonly maxConnections: number;
  readonly logo?: string;
  readonly channelNumber?: number;
  readonly streamId: string;
  readonly muted: boolean;
  readonly status: MultiViewTileStatus;
}

/** Input payload for adding or replacing a Multi-View tile. */
export interface MultiViewAddTileInput {
  readonly itemKey: string;
  readonly title: string;
  readonly sourceId: string;
  readonly accountKey: string;
  readonly maxConnections: number;
  readonly logo?: string;
  readonly channelNumber?: number;
  readonly streamId?: string;
  readonly providerActiveCons?: number;
}

/** Reason why a Multi-View tile admission or replacement was rejected. */
export type MultiViewRejectReason =
  | 'low-ram'
  | 'unsupported'
  | 'device-tile-cap'
  | 'thermal-serious'
  | 'thermal-critical'
  | 'connection-limit'
  | 'duplicate-item'
  | 'closing';

/** Outcome of {@link MultiViewController.addTile} or {@link MultiViewController.replaceTile}. */
export type MultiViewAddResult =
  | { readonly ok: true; readonly tile: MultiViewTile }
  | {
      readonly ok: false;
      readonly reason: MultiViewRejectReason;
      readonly activeCount?: number;
      readonly maxConnections?: number;
      readonly hardwareMaxTiles?: number;
    };

/** Immutable Multi-View grid state snapshot. */
export interface MultiViewState {
  readonly tiles: readonly MultiViewTile[];
  readonly activeAudioTileId: string | null;
  readonly thermalState: ThermalState;
  readonly hardwareMaxTiles: number;
  readonly effectiveMaxTiles: number;
  readonly multiViewSupported: boolean;
  readonly canAddTile: boolean;
}

/** Callback awaited to close a tile's native/desktop playback engine before releasing its connection slot. */
export type MultiViewCloseTileFn = (tile: MultiViewTile) => Promise<void> | void;

/** Options for {@link createMultiViewController}. */
export interface MultiViewControllerOptions {
  readonly capabilities: MultiViewDeviceCapabilities;
  readonly tracker: ConnectionTracker;
  readonly initialThermalState?: ThermalState;
  readonly createTileId?: () => string;
  readonly createStreamId?: (tileId: string) => string;
}

/** Pure Multi-View state and admission controller backed by {@link ConnectionTracker} (`#34`, `#221`, `#232`). */
export interface MultiViewController {
  getState(): MultiViewState;
  subscribe(listener: (state: MultiViewState) => void): () => void;
  addTile(input: MultiViewAddTileInput): MultiViewAddResult;
  removeTile(tileId: string, awaitClose: MultiViewCloseTileFn): Promise<boolean>;
  replaceTile(
    tileId: string,
    nextInput: MultiViewAddTileInput,
    awaitClose: MultiViewCloseTileFn,
  ): Promise<MultiViewAddResult>;
  setActiveAudioTile(tileId: string): boolean;
  updateTileStatus(tileId: string, status: MultiViewTileStatus): boolean;
  applyThermalState(
    nextState: ThermalState,
    awaitCloseTile: MultiViewCloseTileFn,
  ): Promise<readonly string[]>;
  clearAll(awaitCloseTile: MultiViewCloseTileFn): Promise<void>;
}

/**
 * Creates a pure Multi-View admission and tile lifecycle controller (`#34`, `#221`, `#232`).
 * Enforces hardware RAM/model caps, thermal policy, per-account `ConnectionTracker` limits,
 * strictly 1 unmuted active-audio tile, and close-before-release ordering on every teardown.
 */
export function createMultiViewController(
  options: MultiViewControllerOptions,
): MultiViewController {
  const { capabilities, tracker } = options;
  const hardwareMaxTiles = resolveHardwareMultiViewCap(capabilities);
  let tileSeq = 0;
  let streamSeq = 0;
  const nextTileId = options.createTileId ?? (() => `mv-tile-${++tileSeq}`);
  const nextStreamId = options.createStreamId ?? ((tileId: string) => `${tileId}-s${++streamSeq}`);

  let tiles: MultiViewTile[] = [];
  let activeAudioTileId: string | null = null;
  let thermalState: ThermalState = normalizeThermalState(options.initialThermalState);
  let closingAll = false;
  const closingTileIds = new Set<string>();
  const listeners = new Set<(state: MultiViewState) => void>();

  const buildState = (): MultiViewState => {
    const policy = evaluateMultiViewThermalPolicy(capabilities, thermalState, tiles.length);
    return Object.freeze({
      tiles: Object.freeze([...tiles]),
      activeAudioTileId,
      thermalState,
      hardwareMaxTiles: policy.hardwareMaxTiles,
      effectiveMaxTiles: policy.effectiveMaxTiles,
      multiViewSupported: policy.multiViewSupported,
      canAddTile: !closingAll && policy.canAddTile,
    });
  };

  const notify = (): void => {
    const snapshot = buildState();
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(snapshot);
      } catch {
        // Isolate throwing subscribers.
      }
    }
  };

  const syncAudioFlags = (): void => {
    if (tiles.length === 0) {
      activeAudioTileId = null;
      return;
    }
    if (activeAudioTileId === null || !tiles.some((t) => t.tileId === activeAudioTileId)) {
      activeAudioTileId = tiles[0]?.tileId ?? null;
    }
    tiles = tiles.map((tile) => {
      const shouldMute = tile.tileId !== activeAudioTileId;
      return tile.muted === shouldMute ? tile : Object.freeze({ ...tile, muted: shouldMute });
    });
  };

  const makeTile = (
    tileId: string,
    input: MultiViewAddTileInput,
    muted: boolean,
  ): MultiViewTile => {
    const streamId = input.streamId ?? nextStreamId(tileId);
    return Object.freeze({
      tileId,
      itemKey: input.itemKey,
      title: input.title,
      sourceId: input.sourceId,
      accountKey: input.accountKey,
      maxConnections: input.maxConnections,
      ...(input.logo !== undefined ? { logo: input.logo } : {}),
      ...(input.channelNumber !== undefined ? { channelNumber: input.channelNumber } : {}),
      streamId,
      muted,
      status: 'loading',
    });
  };

  const checkThermalAndCap = (
    isReplace: boolean,
  ): Extract<MultiViewAddResult, { ok: false }> | null => {
    if (thermalState === 'critical') {
      return { ok: false, reason: 'thermal-critical', hardwareMaxTiles };
    }
    if (thermalState === 'serious') {
      return { ok: false, reason: 'thermal-serious', hardwareMaxTiles };
    }
    if (!isReplace) {
      if (hardwareMaxTiles <= 1) {
        return {
          ok: false,
          reason: capabilities.supported === false ? 'unsupported' : 'low-ram',
          hardwareMaxTiles,
        };
      }
      if (tiles.length >= hardwareMaxTiles) {
        return { ok: false, reason: 'device-tile-cap', hardwareMaxTiles };
      }
    }
    return null;
  };

  return {
    getState() {
      return buildState();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    addTile(input) {
      if (closingAll) return { ok: false, reason: 'closing' };

      if (tiles.some((t) => !closingTileIds.has(t.tileId) && t.itemKey === input.itemKey)) {
        return { ok: false, reason: 'duplicate-item' };
      }

      const gateError = checkThermalAndCap(false);
      if (gateError !== null) return gateError;

      const limit = tracker.checkLimit({
        accountKey: input.accountKey,
        maxConnections: input.maxConnections,
        ...(input.providerActiveCons === undefined
          ? {}
          : { providerActiveCons: input.providerActiveCons }),
      });
      if (limit.exceeds) {
        return {
          ok: false,
          reason: 'connection-limit',
          activeCount: limit.ownActiveCount,
          maxConnections: limit.maxConnections,
        };
      }

      const tileId = nextTileId();
      const isPrimary = tiles.length === 0 || activeAudioTileId === null;
      const tile = makeTile(tileId, input, !isPrimary);
      tracker.acquire(tile.accountKey, tile.streamId);
      tiles = [...tiles, tile];
      if (isPrimary) {
        activeAudioTileId = tile.tileId;
      }
      notify();
      return { ok: true, tile };
    },

    async removeTile(tileId, awaitClose) {
      const target = tiles.find((t) => t.tileId === tileId);
      if (target === undefined || closingTileIds.has(tileId)) return false;

      closingTileIds.add(tileId);
      try {
        await awaitClose(target);
      } finally {
        tracker.release(target.streamId);
        tiles = tiles.filter((t) => t.tileId !== tileId);
        closingTileIds.delete(tileId);
        if (activeAudioTileId === tileId) {
          activeAudioTileId = null;
        }
        syncAudioFlags();
        notify();
      }
      return true;
    },

    async replaceTile(tileId, nextInput, awaitClose) {
      if (closingAll || closingTileIds.has(tileId)) {
        return { ok: false, reason: 'closing' };
      }
      const oldTile = tiles.find((t) => t.tileId === tileId);
      if (oldTile === undefined) {
        return { ok: false, reason: 'closing' };
      }

      if (
        tiles.some(
          (t) =>
            t.tileId !== tileId && !closingTileIds.has(t.tileId) && t.itemKey === nextInput.itemKey,
        )
      ) {
        return { ok: false, reason: 'duplicate-item' };
      }

      const gateError = checkThermalAndCap(true);
      if (gateError !== null) return gateError;

      const limit = tracker.checkLimit({
        accountKey: nextInput.accountKey,
        maxConnections: nextInput.maxConnections,
        ...(nextInput.accountKey === oldTile.accountKey
          ? { replacingStreamId: oldTile.streamId }
          : {}),
        ...(nextInput.providerActiveCons === undefined
          ? {}
          : { providerActiveCons: nextInput.providerActiveCons }),
      });
      if (limit.exceeds) {
        return {
          ok: false,
          reason: 'connection-limit',
          activeCount: limit.ownActiveCount,
          maxConnections: limit.maxConnections,
        };
      }

      closingTileIds.add(tileId);
      try {
        await awaitClose(oldTile);
      } finally {
        tracker.release(oldTile.streamId);
        closingTileIds.delete(tileId);
      }

      if (closingAll) {
        tiles = tiles.filter((t) => t.tileId !== tileId);
        syncAudioFlags();
        notify();
        return { ok: false, reason: 'closing' };
      }

      const postGateError = checkThermalAndCap(true);
      if (postGateError !== null) {
        tiles = tiles.filter((t) => t.tileId !== tileId);
        syncAudioFlags();
        notify();
        return postGateError;
      }

      const postLimit = tracker.checkLimit({
        accountKey: nextInput.accountKey,
        maxConnections: nextInput.maxConnections,
        ...(nextInput.providerActiveCons === undefined
          ? {}
          : { providerActiveCons: nextInput.providerActiveCons }),
      });
      if (postLimit.exceeds) {
        tiles = tiles.filter((t) => t.tileId !== tileId);
        syncAudioFlags();
        notify();
        return {
          ok: false,
          reason: 'connection-limit',
          activeCount: postLimit.ownActiveCount,
          maxConnections: postLimit.maxConnections,
        };
      }

      const keepActiveAudio = activeAudioTileId === tileId;
      const newTile = makeTile(tileId, nextInput, !keepActiveAudio);
      tracker.acquire(newTile.accountKey, newTile.streamId);
      const idx = tiles.findIndex((t) => t.tileId === tileId);
      if (idx >= 0) {
        tiles = [...tiles.slice(0, idx), newTile, ...tiles.slice(idx + 1)];
      } else {
        tiles = [...tiles, newTile];
      }
      syncAudioFlags();
      notify();
      return { ok: true, tile: newTile };
    },

    setActiveAudioTile(tileId) {
      if (closingTileIds.has(tileId) || !tiles.some((t) => t.tileId === tileId)) {
        return false;
      }
      activeAudioTileId = tileId;
      syncAudioFlags();
      notify();
      return true;
    },

    updateTileStatus(tileId, status) {
      const idx = tiles.findIndex((t) => t.tileId === tileId);
      if (idx < 0) return false;
      const existing = tiles[idx];
      if (existing === undefined || existing.status === status) return true;
      const updated = Object.freeze({ ...existing, status });
      tiles = [...tiles.slice(0, idx), updated, ...tiles.slice(idx + 1)];
      notify();
      return true;
    },

    async applyThermalState(nextState, awaitCloseTile) {
      thermalState = normalizeThermalState(nextState);
      if (thermalState !== 'critical') {
        notify();
        return [];
      }

      const keepId = activeAudioTileId ?? tiles[0]?.tileId ?? null;
      const toShed = tiles.filter((t) => t.tileId !== keepId && !closingTileIds.has(t.tileId));
      const shedIds: string[] = [];

      for (const tile of toShed) {
        closingTileIds.add(tile.tileId);
        try {
          await awaitCloseTile(tile);
        } finally {
          tracker.release(tile.streamId);
          tiles = tiles.filter((t) => t.tileId !== tile.tileId);
          closingTileIds.delete(tile.tileId);
          shedIds.push(tile.tileId);
        }
      }

      syncAudioFlags();
      notify();
      return shedIds;
    },

    async clearAll(awaitCloseTile) {
      closingAll = true;
      const snapshot = tiles.filter((t) => !closingTileIds.has(t.tileId));
      try {
        for (const tile of snapshot) {
          closingTileIds.add(tile.tileId);
          try {
            await awaitCloseTile(tile);
          } finally {
            tracker.release(tile.streamId);
            closingTileIds.delete(tile.tileId);
          }
        }
        tiles = [];
        activeAudioTileId = null;
      } finally {
        closingAll = false;
        notify();
      }
    },
  };
}
