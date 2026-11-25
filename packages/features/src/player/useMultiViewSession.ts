import type { CatalogService, SourceRow } from '@elv/data';
import {
  type ConnectionTracker,
  createMultiViewController,
  createPlaybackService,
  type MultiViewAddResult,
  type MultiViewController,
  type MultiViewState,
  type MultiViewTile,
  type PlaybackClock,
  type PlaybackService,
  type PlaybackTimers,
} from '@elv/playback';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';
import type { OpenVideoEngine, ThermalDevicePort, VideoHost } from '../ports/video-host';
import {
  buildMultiViewTileInput,
  type MultiViewBanner,
  mapAddFailureToBanner,
  mapPlaybackStatusToTileStatus,
  resolveMultiViewCapabilities,
} from './multiview-model';
import { DEFAULT_PLAYER_CLOCK, DEFAULT_PLAYER_TIMERS } from './PlayerScreenParts';
import { isPromiseLike } from './player-overlay-model';

interface MountedTileEngine {
  readonly streamId: string;
  readonly opened: OpenVideoEngine;
  readonly service: PlaybackService;
  readonly unsubscribe: () => void;
}

/** Options for {@link useMultiViewSession}. */
export interface UseMultiViewSessionOptions {
  readonly catalog: Pick<CatalogService, 'resolveStream'>;
  readonly videoHost: VideoHost;
  readonly tracker: ConnectionTracker;
  readonly sources: readonly SourceRow[];
  readonly thermalDevice?: ThermalDevicePort | undefined;
  readonly initialSeed?: PlayableEntry | undefined;
  readonly clock?: PlaybackClock;
  readonly timers?: PlaybackTimers;
}

/** Live controller & engine handle returned by {@link useMultiViewSession}. */
export interface MultiViewSessionHandle {
  readonly state: MultiViewState;
  readonly banner: MultiViewBanner | null;
  readonly engineRevision: number;
  readonly getTileEngine: (tileId: string) => OpenVideoEngine | undefined;
  readonly addChannel: (entry: PlayableEntry) => MultiViewAddResult;
  readonly replaceChannel: (tileId: string, entry: PlayableEntry) => Promise<MultiViewAddResult>;
  readonly removeTile: (tileId: string) => Promise<boolean>;
  readonly selectAudioTile: (tileId: string) => boolean;
  readonly dismissBanner: () => void;
  readonly exitMultiView: () => Promise<PlayTarget | null>;
}

/**
 * Coordinates `@elv/playback`'s `createMultiViewController` with live `VideoHost` tile engines,
 * shared `ConnectionTracker` admission (`#221`), and `ThermalDevicePort` shedding (`#232`).
 */
export function useMultiViewSession({
  catalog,
  videoHost,
  tracker,
  sources,
  thermalDevice,
  initialSeed,
  clock = DEFAULT_PLAYER_CLOCK,
  timers = DEFAULT_PLAYER_TIMERS,
}: UseMultiViewSessionOptions): MultiViewSessionHandle {
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const videoHostRef = useRef(videoHost);
  videoHostRef.current = videoHost;
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const timersRef = useRef(timers);
  timersRef.current = timers;
  const mountedRef = useRef(true);
  const enginesRef = useRef<Map<string, MountedTileEngine>>(new Map());
  const openingTokensRef = useRef<Map<string, number>>(new Map());
  const openSeqRef = useRef(0);

  const [banner, setBanner] = useState<MultiViewBanner | null>(null);
  const [engineRevision, setEngineRevision] = useState(0);

  const capabilities = useMemo(
    () => resolveMultiViewCapabilities(thermalDevice, videoHost),
    [thermalDevice, videoHost],
  );
  const initialThermal = thermalDevice?.getThermalState() ?? 'nominal';

  // biome-ignore lint/correctness/useExhaustiveDependencies: controller instance is bound to tracker & capabilities
  const controller: MultiViewController = useMemo(
    () =>
      createMultiViewController({
        capabilities,
        tracker,
        initialThermalState: initialThermal,
      }),
    [capabilities, tracker],
  );

  const snapshotRef = useRef<MultiViewState | null>(null);
  const prevControllerRef = useRef<MultiViewController | null>(null);
  if (prevControllerRef.current !== controller) {
    prevControllerRef.current = controller;
    snapshotRef.current = controller.getState();
  }

  const subscribe = useCallback(
    (listener: () => void) =>
      controller.subscribe((next) => {
        snapshotRef.current = next;
        listener();
      }),
    [controller],
  );
  const getSnapshot = useCallback((): MultiViewState => {
    snapshotRef.current ??= controller.getState();
    return snapshotRef.current;
  }, [controller]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const bumpEngineRevision = useCallback(() => {
    if (mountedRef.current) setEngineRevision((v) => v + 1);
  }, []);

  const syncEngineAudioStates = useCallback((activeAudioTileId: string | null) => {
    for (const [id, entry] of enginesRef.current) {
      const isPrimary = id === activeAudioTileId;
      entry.opened.setMuted?.(!isPrimary);
      if (isPrimary) {
        entry.opened.setPrimary?.();
      }
    }
  }, []);

  const closeTileEngine = useCallback(
    async (tile: MultiViewTile): Promise<void> => {
      openingTokensRef.current.delete(tile.tileId);
      const mounted = enginesRef.current.get(tile.tileId);
      if (mounted === undefined) return;
      enginesRef.current.delete(tile.tileId);
      mounted.unsubscribe();
      try {
        mounted.service.stop();
        mounted.service.dispose();
      } finally {
        mounted.opened.engine.release();
      }
      await Promise.resolve();
      bumpEngineRevision();
    },
    [bumpEngineRevision],
  );

  const mountTileEngine = useCallback(
    (tile: MultiViewTile, totalTileCount: number): void => {
      const token = ++openSeqRef.current;
      openingTokensRef.current.set(tile.tileId, token);
      const isPrimary = !tile.muted;

      const attach = (opened: OpenVideoEngine | null): void => {
        if (!mountedRef.current || openingTokensRef.current.get(tile.tileId) !== token) {
          opened?.engine.release();
          return;
        }
        if (opened === null) {
          controller.updateTileStatus(tile.tileId, 'error');
          return;
        }
        opened.setMuted?.(tile.muted);
        if (isPrimary) {
          opened.setPrimary?.();
        }
        const service = createPlaybackService({
          engine: opened.engine,
          clock: clockRef.current,
          timers: timersRef.current,
        });
        const unsubscribe = service.subscribe(() => {
          const kind = service.getState().status.kind;
          controller.updateTileStatus(tile.tileId, mapPlaybackStatusToTileStatus(kind));
        });
        enginesRef.current.set(tile.tileId, {
          streamId: tile.streamId,
          opened,
          service,
          unsubscribe,
        });
        bumpEngineRevision();

        void service.tune({
          item: tile.itemKey,
          kind: 'live',
          accountKey: tile.accountKey,
          resolve: () => catalogRef.current.resolveStream(tile.itemKey),
        });
      };

      try {
        const openedOrPromise = videoHostRef.current.open({
          replaceExisting: false,
          primary: isPrimary,
          handleAudioFocus: isPrimary,
          multiViewTileCount: totalTileCount,
        });
        if (isPromiseLike(openedOrPromise)) {
          openedOrPromise.then(attach, () => {
            if (mountedRef.current && openingTokensRef.current.get(tile.tileId) === token) {
              controller.updateTileStatus(tile.tileId, 'error');
            }
          });
        } else {
          attach(openedOrPromise);
        }
      } catch {
        controller.updateTileStatus(tile.tileId, 'error');
      }
    },
    [bumpEngineRevision, controller],
  );

  // Seed Tile 1 on mount when launched from single-player.
  const seededRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    if (!seededRef.current && initialSeed !== undefined) {
      seededRef.current = true;
      const res = controller.addTile(buildMultiViewTileInput(initialSeed, sourcesRef.current));
      if (res.ok) {
        mountTileEngine(res.tile, controller.getState().tiles.length);
      } else {
        setBanner(mapAddFailureToBanner(res));
      }
    }
    return () => {
      mountedRef.current = false;
      void controller.clearAll(closeTileEngine);
    };
  }, [closeTileEngine, controller, initialSeed, mountTileEngine]);

  // Subscribe to native thermal state transitions (#232).
  useEffect(() => {
    if (thermalDevice === undefined) return;
    const handleThermal = (nextState: ReturnType<ThermalDevicePort['getThermalState']>) => {
      void controller.applyThermalState(nextState, closeTileEngine).then((shedIds) => {
        if (!mountedRef.current) return;
        syncEngineAudioStates(controller.getState().activeAudioTileId);
        if (nextState === 'critical') {
          setBanner({ kind: 'thermal-critical', shedCount: shedIds.length });
        } else if (nextState === 'serious') {
          setBanner({ kind: 'thermal-serious' });
        } else {
          setBanner((prev) =>
            prev?.kind === 'thermal-serious' || prev?.kind === 'thermal-critical' ? null : prev,
          );
        }
      });
    };
    return thermalDevice.subscribeThermalState(handleThermal);
  }, [closeTileEngine, controller, syncEngineAudioStates, thermalDevice]);

  const addChannel = useCallback(
    (entry: PlayableEntry): MultiViewAddResult => {
      const res = controller.addTile(buildMultiViewTileInput(entry, sourcesRef.current));
      if (!res.ok) {
        const nextBanner = mapAddFailureToBanner(res);
        if (nextBanner !== null) setBanner(nextBanner);
        return res;
      }
      setBanner((prev) =>
        prev?.kind === 'thermal-serious' || prev?.kind === 'thermal-critical' ? prev : null,
      );
      mountTileEngine(res.tile, controller.getState().tiles.length);
      return res;
    },
    [controller, mountTileEngine],
  );

  const replaceChannel = useCallback(
    async (tileId: string, entry: PlayableEntry): Promise<MultiViewAddResult> => {
      const res = await controller.replaceTile(
        tileId,
        buildMultiViewTileInput(entry, sourcesRef.current),
        closeTileEngine,
      );
      if (!res.ok) {
        const nextBanner = mapAddFailureToBanner(res);
        if (nextBanner !== null) setBanner(nextBanner);
        return res;
      }
      setBanner((prev) =>
        prev?.kind === 'thermal-serious' || prev?.kind === 'thermal-critical' ? prev : null,
      );
      mountTileEngine(res.tile, controller.getState().tiles.length);
      syncEngineAudioStates(controller.getState().activeAudioTileId);
      return res;
    },
    [closeTileEngine, controller, mountTileEngine, syncEngineAudioStates],
  );

  const removeTile = useCallback(
    async (tileId: string): Promise<boolean> => {
      const removed = await controller.removeTile(tileId, closeTileEngine);
      if (removed) {
        syncEngineAudioStates(controller.getState().activeAudioTileId);
      }
      return removed;
    },
    [closeTileEngine, controller, syncEngineAudioStates],
  );

  const selectAudioTile = useCallback(
    (tileId: string): boolean => {
      const changed = controller.setActiveAudioTile(tileId);
      if (changed) {
        syncEngineAudioStates(tileId);
      }
      return changed;
    },
    [controller, syncEngineAudioStates],
  );

  const exitMultiView = useCallback(async (): Promise<PlayTarget | null> => {
    const snap = controller.getState();
    const activeTile = snap.tiles.find((t) => t.tileId === snap.activeAudioTileId) ?? snap.tiles[0];
    await controller.clearAll(closeTileEngine);
    if (activeTile === undefined) return null;
    return {
      itemKey: activeTile.itemKey,
      sourceId: activeTile.sourceId,
      accountKey: activeTile.accountKey,
      title: activeTile.title,
      kind: 'live',
      itemKind: 'live',
      ...(activeTile.logo !== undefined ? { logo: activeTile.logo } : {}),
    };
  }, [closeTileEngine, controller]);

  const dismissBanner = useCallback(() => setBanner(null), []);
  const getTileEngine = useCallback(
    (tileId: string): OpenVideoEngine | undefined => enginesRef.current.get(tileId)?.opened,
    [],
  );

  return {
    state,
    banner,
    engineRevision,
    getTileEngine,
    addChannel,
    replaceChannel,
    removeTile,
    selectAudioTile,
    dismissBanner,
    exitMultiView,
  };
}
