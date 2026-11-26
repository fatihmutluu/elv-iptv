import type { CatalogService, SourceRow } from '@elv/data';
import { type DeinterlaceMode, ok } from '@elv/domain';
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
import type {
  AdoptedPlaybackSession,
  OpenVideoEngine,
  ThermalDevicePort,
  VideoHost,
} from '../ports/video-host';
import {
  buildMultiViewTileInput,
  type MultiViewBanner,
  mapAddFailureToBanner,
  mapPlaybackStatusToTileStatus,
  resolveMultiViewCapabilities,
} from './multiview-model';
import { DEFAULT_PLAYER_CLOCK, DEFAULT_PLAYER_TIMERS } from './PlayerScreenParts';
import { clampVolume, isPromiseLike } from './player-overlay-model';

interface MountedTileEngine {
  readonly streamId: string;
  readonly opened: OpenVideoEngine;
  readonly service: PlaybackService;
  readonly unsubscribe: () => void;
}

/** Result returned when exiting Multi-View or auto-soloing back to single-player (`Wave P3`). */
interface MultiViewExitResult {
  readonly resumeTarget: PlayTarget | null;
  readonly adoptedSession: AdoptedPlaybackSession | null;
}

/** Result returned by {@link MultiViewSessionHandle.removeTile} with authoritative post-removal tile count. */
interface MultiViewRemoveResult {
  readonly removed: boolean;
  readonly remainingCount: number;
}

/** Options for {@link useMultiViewSession}. */
export interface UseMultiViewSessionOptions {
  readonly catalog: Pick<CatalogService, 'resolveStream'>;
  readonly videoHost: VideoHost;
  readonly tracker: ConnectionTracker;
  readonly sources: readonly SourceRow[];
  readonly thermalDevice?: ThermalDevicePort | undefined;
  readonly initialSeed?: PlayableEntry | undefined;
  readonly initialAdoptedSession?: AdoptedPlaybackSession | undefined;
  readonly onConsumeAdoptedSession?: ((session: AdoptedPlaybackSession) => void) | undefined;
  readonly initialVolume?: number | undefined;
  readonly onPersistVolume?: ((volume: number) => void) | undefined;
  readonly preferredAudioDevice?: string | undefined;
  readonly audioNormalization?: boolean | undefined;
  readonly pitchLock?: boolean | undefined;
  readonly deinterlaceMode?: DeinterlaceMode | undefined;
  readonly clock?: PlaybackClock;
  readonly timers?: PlaybackTimers;
}

/** Live controller & engine handle returned by {@link useMultiViewSession}. */
export interface MultiViewSessionHandle {
  readonly state: MultiViewState;
  readonly banner: MultiViewBanner | null;
  readonly engineRevision: number;
  readonly volume: number;
  readonly muted: boolean;
  readonly setVolume: (volume: number) => void;
  readonly toggleMute: () => void;
  readonly getTileEngine: (tileId: string) => OpenVideoEngine | undefined;
  readonly addChannel: (entry: PlayableEntry) => MultiViewAddResult;
  readonly replaceChannel: (tileId: string, entry: PlayableEntry) => Promise<MultiViewAddResult>;
  readonly removeTile: (tileId: string) => Promise<MultiViewRemoveResult>;
  readonly selectAudioTile: (tileId: string) => boolean;
  readonly dismissBanner: () => void;
  readonly exitMultiView: () => Promise<MultiViewExitResult>;
}

/**
 * Coordinates `@elv/playback`'s `createMultiViewController` with live `VideoHost` tile engines,
 * zero-reload `AdoptedPlaybackSession` entry/exit (`Wave P3`), shared audio/video preferences,
 * `ConnectionTracker` admission (`#221`), and `ThermalDevicePort` shedding (`#232`).
 */
export function useMultiViewSession({
  catalog,
  videoHost,
  tracker,
  sources,
  thermalDevice,
  initialSeed,
  initialAdoptedSession,
  onConsumeAdoptedSession,
  initialVolume,
  onPersistVolume,
  preferredAudioDevice,
  audioNormalization,
  pitchLock,
  deinterlaceMode,
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
  const onPersistVolumeRef = useRef(onPersistVolume);
  onPersistVolumeRef.current = onPersistVolume;
  const preferredAudioDeviceRef = useRef(preferredAudioDevice);
  preferredAudioDeviceRef.current = preferredAudioDevice;
  const audioNormalizationRef = useRef(audioNormalization);
  audioNormalizationRef.current = audioNormalization;
  const pitchLockRef = useRef(pitchLock);
  pitchLockRef.current = pitchLock;
  const deinterlaceModeRef = useRef(deinterlaceMode);
  deinterlaceModeRef.current = deinterlaceMode;
  const initialAdoptedRef = useRef(initialAdoptedSession);
  const onConsumeAdoptedRef = useRef(onConsumeAdoptedSession);
  onConsumeAdoptedRef.current = onConsumeAdoptedSession;

  const mountedRef = useRef(true);
  const enginesRef = useRef<Map<string, MountedTileEngine>>(new Map());
  const tileTargetsRef = useRef<Map<string, PlayTarget>>(new Map());
  const openingTokensRef = useRef<Map<string, number>>(new Map());
  const openSeqRef = useRef(0);

  const [banner, setBanner] = useState<MultiViewBanner | null>(null);
  const [engineRevision, setEngineRevision] = useState(0);
  const [volume, setVolumeState] = useState<number>(() =>
    clampVolume(initialAdoptedSession?.volume ?? initialVolume ?? 100),
  );
  const [muted, setMutedState] = useState<boolean>(() => initialAdoptedSession?.muted === true);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

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

  const applyPreferencesToOpened = useCallback((opened: OpenVideoEngine, isPrimary: boolean) => {
    opened.setVolume?.(volumeRef.current);
    opened.setMuted?.(!isPrimary || mutedRef.current);
    if (isPrimary) {
      opened.setPrimary?.();
    }
    const savedDevice = preferredAudioDeviceRef.current?.trim();
    if (savedDevice && savedDevice !== 'auto') {
      opened.setAudioDevice?.(savedDevice);
    }
    if (audioNormalizationRef.current !== undefined) {
      opened.setAudioNormalization?.(audioNormalizationRef.current);
    }
    if (pitchLockRef.current !== undefined) {
      opened.setPitchLock?.(pitchLockRef.current);
    }
    if (deinterlaceModeRef.current !== undefined) {
      opened.setDeinterlaceMode?.(deinterlaceModeRef.current);
    }
  }, []);

  const syncEngineAudioStates = useCallback((activeAudioTileId: string | null) => {
    for (const [id, entry] of enginesRef.current) {
      const isPrimary = id === activeAudioTileId;
      entry.opened.setMuted?.(!isPrimary || mutedRef.current);
      if (isPrimary) {
        entry.opened.setVolume?.(volumeRef.current);
        entry.opened.setPrimary?.();
      }
    }
  }, []);

  useEffect(() => {
    const savedDevice = preferredAudioDevice?.trim();
    for (const entry of enginesRef.current.values()) {
      if (savedDevice && savedDevice !== 'auto') {
        entry.opened.setAudioDevice?.(savedDevice);
      }
      if (audioNormalization !== undefined) {
        entry.opened.setAudioNormalization?.(audioNormalization);
      }
      if (pitchLock !== undefined) {
        entry.opened.setPitchLock?.(pitchLock);
      }
      if (deinterlaceMode !== undefined) {
        entry.opened.setDeinterlaceMode?.(deinterlaceMode);
      }
    }
  }, [audioNormalization, deinterlaceMode, pitchLock, preferredAudioDevice]);

  const setVolume = useCallback(
    (next: number) => {
      const clamped = clampVolume(next);
      volumeRef.current = clamped;
      setVolumeState(clamped);
      let unmuted = false;
      if (clamped > 0 && mutedRef.current) {
        mutedRef.current = false;
        setMutedState(false);
        unmuted = true;
      }
      const activeId = controller.getState().activeAudioTileId;
      for (const [id, entry] of enginesRef.current) {
        entry.opened.setVolume?.(clamped);
        if (unmuted && id === activeId) {
          entry.opened.setMuted?.(false);
        }
      }
      onPersistVolumeRef.current?.(clamped);
    },
    [controller],
  );

  const toggleMute = useCallback(() => {
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted;
    setMutedState(nextMuted);
    syncEngineAudioStates(controller.getState().activeAudioTileId);
  }, [controller, syncEngineAudioStates]);

  const closeTileEngine = useCallback(
    async (tile: MultiViewTile): Promise<void> => {
      openingTokensRef.current.delete(tile.tileId);
      tileTargetsRef.current.delete(tile.tileId);
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

  const attachAdoptedTileEngine = useCallback(
    (tile: MultiViewTile, adopted: AdoptedPlaybackSession): void => {
      const isPrimary = !tile.muted;
      applyPreferencesToOpened(adopted.opened, isPrimary);
      const initialKind = adopted.service.getState().status.kind;
      controller.updateTileStatus(tile.tileId, mapPlaybackStatusToTileStatus(initialKind));
      const unsubscribe = adopted.service.subscribe(() => {
        const kind = adopted.service.getState().status.kind;
        controller.updateTileStatus(tile.tileId, mapPlaybackStatusToTileStatus(kind));
      });
      enginesRef.current.set(tile.tileId, {
        streamId: tile.streamId,
        opened: adopted.opened,
        service: adopted.service,
        unsubscribe,
      });
      tileTargetsRef.current.set(tile.tileId, adopted.target);
      bumpEngineRevision();
    },
    [applyPreferencesToOpened, bumpEngineRevision, controller],
  );

  const mountTileEngine = useCallback(
    (tile: MultiViewTile, totalTileCount: number, entry?: PlayableEntry): void => {
      const token = ++openSeqRef.current;
      openingTokensRef.current.set(tile.tileId, token);
      if (entry !== undefined) {
        tileTargetsRef.current.set(tile.tileId, entry);
      }
      const isPrimary = !tile.muted;
      const storedEntry = entry ?? tileTargetsRef.current.get(tile.tileId);
      const localOfflineUri =
        tile.isLocalOffline === true &&
        typeof storedEntry?.localFileUri === 'string' &&
        storedEntry.localFileUri.length > 0
          ? storedEntry.localFileUri
          : null;
      const tuneKind: 'live' | 'vod' =
        tile.kind === 'live' || tile.kind === undefined ? 'live' : 'vod';

      const attach = (opened: OpenVideoEngine | null): void => {
        if (!mountedRef.current || openingTokensRef.current.get(tile.tileId) !== token) {
          opened?.engine.release();
          return;
        }
        if (opened === null) {
          controller.updateTileStatus(tile.tileId, 'error');
          return;
        }
        applyPreferencesToOpened(opened, isPrimary);
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
          kind: tuneKind,
          accountKey: tile.accountKey,
          resolve:
            localOfflineUri !== null
              ? async () =>
                  ok({
                    url: localOfflineUri,
                    headers: {},
                    sourceId: tile.sourceId,
                    channelKey: tile.itemKey,
                  })
              : () => catalogRef.current.resolveStream(tile.itemKey),
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
    [applyPreferencesToOpened, bumpEngineRevision, controller],
  );

  // Seed Tile 1 on mount (adopting live session when launched from single-player, zero reload).
  const seededRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    if (!seededRef.current) {
      const adopted = initialAdoptedRef.current;
      const seedEntry = initialSeed ?? adopted?.target;
      if (seedEntry !== undefined) {
        seededRef.current = true;
        initialAdoptedRef.current = undefined;
        const baseInput = buildMultiViewTileInput(seedEntry, sourcesRef.current);
        const res = controller.addTile(
          adopted !== undefined ? { ...baseInput, adoptedExistingStream: true } : baseInput,
        );
        if (res.ok) {
          if (adopted !== undefined) {
            onConsumeAdoptedRef.current?.(adopted);
            attachAdoptedTileEngine(res.tile, adopted);
          } else {
            mountTileEngine(res.tile, controller.getState().tiles.length, seedEntry);
          }
        } else {
          if (adopted !== undefined) {
            onConsumeAdoptedRef.current?.(adopted);
            try {
              adopted.service.stop();
              adopted.service.dispose();
            } finally {
              adopted.opened.engine.release();
            }
          }
          setBanner(mapAddFailureToBanner(res));
        }
      }
    }
    return () => {
      mountedRef.current = false;
      void controller.clearAll(closeTileEngine);
    };
  }, [attachAdoptedTileEngine, closeTileEngine, controller, initialSeed, mountTileEngine]);

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
      mountTileEngine(res.tile, controller.getState().tiles.length, entry);
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
      mountTileEngine(res.tile, controller.getState().tiles.length, entry);
      syncEngineAudioStates(controller.getState().activeAudioTileId);
      return res;
    },
    [closeTileEngine, controller, mountTileEngine, syncEngineAudioStates],
  );

  const removeTile = useCallback(
    async (tileId: string): Promise<MultiViewRemoveResult> => {
      const removed = await controller.removeTile(tileId, closeTileEngine);
      const snap = controller.getState();
      if (removed) {
        syncEngineAudioStates(snap.activeAudioTileId);
      }
      return { removed, remainingCount: snap.tiles.length };
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

  const exitMultiView = useCallback(async (): Promise<MultiViewExitResult> => {
    const snap = controller.getState();
    const activeTile = snap.tiles.find((t) => t.tileId === snap.activeAudioTileId) ?? snap.tiles[0];
    if (activeTile === undefined) {
      await controller.clearAll(closeTileEngine);
      return { resumeTarget: null, adoptedSession: null };
    }
    const preservedTarget = tileTargetsRef.current.get(activeTile.tileId);
    const fallbackKind: 'live' | 'vod' =
      activeTile.kind === 'live' || activeTile.kind === undefined ? 'live' : 'vod';
    const fallbackItemKind =
      activeTile.kind === 'episode' ? 'episode' : activeTile.kind === 'movie' ? 'movie' : 'live';
    const resumeTarget: PlayTarget = preservedTarget ?? {
      itemKey: activeTile.itemKey,
      sourceId: activeTile.sourceId,
      accountKey: activeTile.accountKey,
      title: activeTile.title,
      kind: fallbackKind,
      itemKind: fallbackItemKind,
      ...(activeTile.isLocalOffline === true ? { isLocalOffline: true } : {}),
      ...(activeTile.logo !== undefined ? { logo: activeTile.logo } : {}),
    };
    const mounted = enginesRef.current.get(activeTile.tileId);
    let adoptedSession: AdoptedPlaybackSession | null = null;
    if (mounted !== undefined) {
      enginesRef.current.delete(activeTile.tileId);
      openingTokensRef.current.delete(activeTile.tileId);
      tileTargetsRef.current.delete(activeTile.tileId);
      mounted.unsubscribe();
      mounted.opened.setPrimary?.();
      mounted.opened.setMuted?.(mutedRef.current);
      mounted.opened.setVolume?.(volumeRef.current);
      const svcState = mounted.service.getState();
      adoptedSession = {
        opened: mounted.opened,
        service: mounted.service,
        target: resumeTarget,
        muted: mutedRef.current,
        volume: volumeRef.current,
        status: svcState.status,
        tracks: svcState.tracks,
        ...(svcState.videoInfo !== undefined ? { mediaInfo: svcState.videoInfo } : {}),
      };
    }
    await controller.clearAll(async (tile) => {
      if (tile.tileId === activeTile.tileId && adoptedSession !== null) return;
      await closeTileEngine(tile);
    });
    return { resumeTarget, adoptedSession };
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
    volume,
    muted,
    setVolume,
    toggleMute,
    getTileEngine,
    addChannel,
    replaceChannel,
    removeTile,
    selectAudioTile,
    dismissBanner,
    exitMultiView,
  };
}
