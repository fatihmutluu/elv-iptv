import type {
  AttemptToken,
  EngineCapabilities,
  EngineEvent,
  ExternalSubtitleTrack,
  LoadCommand,
  PlayerEngine,
} from '@elv/playback';
import type {
  AccessibilityFontFamily,
  AudioDeviceInfo,
  BridgeCommand,
  DeinterlaceMode,
  DesktopMediaMetadata,
  HwdecProfile,
  PlayerArea,
  PlayerBridge,
  PlayerEventMessage,
  PlayerRemoteMediaActionMessage,
  PlayerUiEvent,
  PlayerUiMessage,
  QueueNextRequest,
  RemoteMediaAction,
  ResizeMode,
  SubtitleStyleConfig,
  VideoFrameLike,
} from '../../../src/shared/player-ipc.ts';

/**
 * The renderer's copy of `DESKTOP_CAPABILITIES` (`src/shared/player-ipc.ts`). The renderer imports that module for
 * types only so Metro never resolves it; a test keeps the two equal.
 */
const CAPABILITIES: EngineCapabilities = Object.freeze({
  mpegTsOverHttp: true,
  hls: true,
  liveSeek: true,
  softwareAudioFallback: false,
  recreate: true,
  audioTrackSelection: true,
  subtitleTrackSelection: true,
  audioDelay: true,
  subtitleDelay: true,
  videoQualitySelection: true,
  externalSubtitles: true,
  subtitleStyling: true,
  dualSubtitles: true,
});

/** The renderer's `PlayerEngine` for the desktop app, plus the presenter's controls. */
export interface DesktopEngine extends PlayerEngine {
  readonly engineId: string;
  /** Sets VOD playback speed on the active attempt (`#434`). */
  setSpeed(attempt: AttemptToken, rate: number): void;
  /** Tells main where the video belongs, in CSS pixels of the window content. */
  setArea(area: PlayerArea): void;
  /** Toggles the presenter's fullscreen (not a port command). */
  toggleFullscreen(): void;
  /** Returns the latest known fullscreen state of the desktop presenter window (`#394`). */
  isFullscreen(): boolean;
  /** Toggles mpv audio mute (`cycle mute`). */
  toggleMute(): void;
  /** Sets mpv output volume (`0`–`100`, `#434`). */
  setVolume(volume: number): void;
  /** Sets mpv audio delay (`(attempt, delayMs)` in ms per `PlayerEngine`, or `(delaySec)` in seconds, `#59`, `#239`, `#434`). */
  setAudioDelay(attempt: AttemptToken, delayMs: number): void;
  setAudioDelay(delaySec: number): void;
  /** Sets mpv subtitle delay (`(attempt, delayMs)` in ms per `PlayerEngine`, or `(delaySec)` in seconds, `#59`, `#239`, `#434`). */
  setSubtitleDelay(attempt: AttemptToken, delayMs: number): void;
  setSubtitleDelay(delaySec: number): void;
  /** Selects an mpv audio output device (`#434`, `#408`). */
  setAudioDevice(device: string): void;
  /** Returns the latest normalized desktop `libmpv` audio output device list (`#408`). */
  getAudioDevices(): readonly AudioDeviceInfo[];
  /** Returns the active desktop `libmpv` audio output device id (`#408`). */
  getActiveAudioDevice(): string;
  /** Subscribes to live desktop audio output device list or active selection changes (`#408`). */
  onAudioDevicesChange(
    listener: (devices: readonly AudioDeviceInfo[], active: string) => void,
  ): () => void;
  /** Enables or disables per-file mpv deinterlacing (`#131`). */
  setDeinterlace(enabled: boolean): void;
  /** Selects the mpv deinterlacing pipeline (`off` / `auto` / `bwdif`, `#243`). */
  setDeinterlaceMode(mode: DeinterlaceMode): void;
  /** Toggles mpv `scaletempo2` pitch preservation (`audio-pitch-correction`, `#243`). */
  setPitchLock(lockedOrAttempt: boolean | AttemptToken, maybeLocked?: boolean): void;
  /** Toggles labeled EBU R128 `@elv_loudnorm` audio normalization (`#243`). */
  setAudioNormalization(enabled: boolean): void;
  /** Queues the next resolved VOD episode via mpv `append-play` (`#205`). */
  queueNext(request: QueueNextRequest): void;
  /** Clears any pending queued `append-play` episode (`#205`). */
  clearQueue(): void;
  /** Subscribes to gapless queue advancement notifications (`#205`); returns unsubscribe. */
  onQueueAdvanced(listener: (itemKey: string) => void): () => void;
  /** Selects the desktop `libmpv` hardware video decoding profile (`#435`, `#210`). */
  setHwdec(profile: HwdecProfile): void;
  /** Sets picture scaling mode (`fit` / `fill` / `stretch`) on non-canvas mpv presenters (`#124`). */
  setResizeMode(mode: ResizeMode): void;
  /** Toggles mpv's built-in SDH subtitle annotation filter (`sub-filter-sdh`, `#310`). */
  setFilterSdh(enabled: boolean): void;
  /** Selects the mpv subtitle font family (`sub-font`, `#163`). */
  setSubtitleFontFamily(family: AccessibilityFontFamily): void;
  /** Mirrors typed playback metadata to main-process OS media bridges (MPRIS2 / macOS Now Playing, `#238`, `#301`). */
  setMediaMetadata(metadata: DesktopMediaMetadata | null): void;
  /** Subscribes to OS remote track-step actions (`next` / `previous`) from main; returns unsubscribe. */
  onRemoteMediaAction(listener: (action: RemoteMediaAction) => void): () => void;
  /** Presentation events outside the port; the latest `presenter` event is replayed to a new listener. */
  onUi(listener: (event: PlayerUiEvent) => void): () => void;
  /** Subscribes to decoded GPU `VideoFrame` deliveries in `'canvas'` mode (`#95`); returns unsubscribe. */
  onFrame?(listener: (frame: VideoFrameLike) => void): () => void;
}

const MAX_HELD_EVENTS = 100;

const shiftAnchor = (event: EngineEvent, offset: number): EngineEvent => {
  switch (event.type) {
    case 'firstFrame':
    case 'stall':
      return { ...event, atMs: event.atMs + offset };
    case 'clock':
      return { ...event, anchor: { ...event.anchor, atMs: event.anchor.atMs + offset } };
    default:
      return event;
  }
};

/**
 * Opens an engine in the main process over `bridge` and returns its proxy. Main stamps events with its own clock;
 * the open handshake measures the offset to `now` (the midpoint of the round trip) and every `atMs` is mapped to the
 * renderer's clock. Messages that beat the open reply are held and applied once the engine id is known.
 */
export async function createDesktopEngine(
  bridge: PlayerBridge,
  now: () => number,
): Promise<DesktopEngine> {
  const listeners = new Set<(event: EngineEvent) => void>();
  const uiListeners = new Set<(event: PlayerUiEvent) => void>();
  const audioDeviceListeners = new Set<
    (devices: readonly AudioDeviceInfo[], active: string) => void
  >();
  const queueAdvancedListeners = new Set<(itemKey: string) => void>();
  const remoteMediaActionListeners = new Set<(action: RemoteMediaAction) => void>();
  const frameUnsubs = new Set<() => void>();
  let engineId: string | undefined;
  let offset = 0;
  let released = false;
  let everSubscribed = false;
  const heldEvents: EngineEvent[] = [];
  let presenter: Extract<PlayerUiEvent, { type: 'presenter' }> | undefined;
  let fullscreenEvent: Extract<PlayerUiEvent, { type: 'fullscreen-changed' }> | undefined;
  let audioDevicesEvent: Extract<PlayerUiEvent, { type: 'audio-devices' }> | undefined;
  let fullscreen = false;
  let audioDevices: readonly AudioDeviceInfo[] = [];
  let activeAudioDevice = 'auto';
  const earlyEvents: PlayerEventMessage[] = [];
  const earlyUi: PlayerUiMessage[] = [];
  const earlyRemoteActions: PlayerRemoteMediaActionMessage[] = [];

  const deliverEvent = (event: EngineEvent): void => {
    const mapped = shiftAnchor(event, offset);
    // Nobody can have subscribed before the open reply; the first subscriber gets what came before it.
    if (!everSubscribed) {
      if (heldEvents.length < MAX_HELD_EVENTS) heldEvents.push(mapped);
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(mapped);
      } catch {
        // a listener bug must not stop the others
      }
    }
  };
  const deliverUi = (ui: PlayerUiEvent): void => {
    if (ui.type === 'presenter') presenter = ui;
    if (ui.type === 'fullscreen-changed') {
      fullscreen = ui.fullscreen;
      fullscreenEvent = ui;
    }
    if (ui.type === 'audio-devices') {
      audioDevices = ui.devices;
      activeAudioDevice = ui.active;
      audioDevicesEvent = ui;
      for (const listener of [...audioDeviceListeners]) {
        try {
          listener(ui.devices, ui.active);
        } catch {
          // isolate audio device subscribers
        }
      }
    }
    if (ui.type === 'queueAdvanced') {
      for (const listener of [...queueAdvancedListeners]) {
        try {
          listener(ui.itemKey);
        } catch {
          // isolate queueAdvanced subscribers
        }
      }
    }
    for (const listener of [...uiListeners]) {
      try {
        listener(ui);
      } catch {
        // same isolation as engine listeners
      }
    }
  };

  const deliverRemoteAction = (action: RemoteMediaAction): void => {
    for (const listener of [...remoteMediaActionListeners]) {
      try {
        listener(action);
      } catch {
        // isolate remote media action subscribers
      }
    }
  };

  const offEvent = bridge.onEvent((message) => {
    if (engineId === undefined) {
      if (earlyEvents.length < MAX_HELD_EVENTS) earlyEvents.push(message);
    } else if (message.engineId === engineId) {
      deliverEvent(message.event);
    }
  });
  const offUi = bridge.onUi((message) => {
    if (engineId === undefined) {
      if (earlyUi.length < MAX_HELD_EVENTS) earlyUi.push(message);
      else if (message.ui.type === 'presenter') earlyUi[earlyUi.length - 1] = message;
    } else if (message.engineId === engineId) {
      deliverUi(message.ui);
    }
  });
  const offRemoteAction =
    bridge.onRemoteMediaAction?.((message) => {
      if (engineId === undefined) {
        if (earlyRemoteActions.length < MAX_HELD_EVENTS) earlyRemoteActions.push(message);
      } else if (message.engineId === engineId) {
        deliverRemoteAction(message.action);
      }
    }) ?? (() => undefined);

  const t0 = now();
  let reply: Awaited<ReturnType<PlayerBridge['open']>>;
  try {
    reply = await bridge.open();
  } catch (error) {
    offEvent();
    offUi();
    offRemoteAction();
    throw error;
  }
  offset = (t0 + now()) / 2 - reply.mainNowMs;
  engineId = reply.engineId;
  const id = reply.engineId;
  for (const m of earlyUi.splice(0)) if (m.engineId === id) deliverUi(m.ui);
  for (const m of earlyEvents.splice(0)) if (m.engineId === id) deliverEvent(m.event);
  for (const m of earlyRemoteActions.splice(0))
    if (m.engineId === id) deliverRemoteAction(m.action);

  const send = (command: BridgeCommand): void => {
    if (!released) bridge.send({ engineId: id, command });
  };

  return {
    capabilities: CAPABILITIES,
    engineId: id,
    load: (cmd: LoadCommand) => send({ name: 'load', cmd }),
    retry: (attempt: AttemptToken) => send({ name: 'retry', attempt }),
    play: (attempt) => send({ name: 'play', attempt }),
    pause: (attempt) => send({ name: 'pause', attempt }),
    seek: (attempt, positionMs) => send({ name: 'seek', attempt, positionMs }),
    jumpToLiveEdge: (attempt) => send({ name: 'jumpToLiveEdge', attempt }),
    setSpeed: (attempt, rate) => send({ name: 'setSpeed', attempt, rate }),
    selectAudioTrack: (attempt, trackId) =>
      send({ name: 'selectAudioTrack', attempt, id: trackId }),
    selectSubtitleTrack: (attempt, trackId) =>
      send({ name: 'selectSubtitleTrack', attempt, id: trackId }),
    selectSecondarySubtitleTrack: (attempt, trackId) =>
      send({ name: 'selectSecondarySubtitleTrack', attempt, id: trackId }),
    addExternalSubtitle: (attempt: AttemptToken, track: ExternalSubtitleTrack) =>
      send({ name: 'addExternalSubtitle', attempt, track }),
    setSubtitleStyle: (style: SubtitleStyleConfig) => send({ name: 'setSubtitleStyle', style }),
    selectVideoQuality: (attempt, qualityId) =>
      send({ name: 'selectVideoQuality', attempt, id: qualityId }),
    stop: (attempt) => send({ name: 'stop', attempt }),
    recreate: (attempt) => send({ name: 'recreate', attempt }),
    toggleFullscreen: () => send({ name: 'fullscreen' }),
    isFullscreen: () => fullscreen,
    toggleMute: () => send({ name: 'mute' }),
    setVolume: (volume) => send({ name: 'setVolume', volume }),
    setAudioDelay(attemptOrDelaySec: AttemptToken | number, maybeDelayMs?: number) {
      if (maybeDelayMs !== undefined) {
        if (!Number.isFinite(maybeDelayMs)) return;
        const clampedSec = Math.max(-30_000, Math.min(30_000, maybeDelayMs)) / 1000;
        send({ name: 'setAudioDelay', attempt: attemptOrDelaySec, delaySec: clampedSec });
        return;
      }
      if (!Number.isFinite(attemptOrDelaySec)) return;
      send({ name: 'setAudioDelay', delaySec: Math.max(-30, Math.min(30, attemptOrDelaySec)) });
    },
    setSubtitleDelay(attemptOrDelaySec: AttemptToken | number, maybeDelayMs?: number) {
      if (maybeDelayMs !== undefined) {
        if (!Number.isFinite(maybeDelayMs)) return;
        const clampedSec = Math.max(-30_000, Math.min(30_000, maybeDelayMs)) / 1000;
        send({ name: 'setSubtitleDelay', attempt: attemptOrDelaySec, delaySec: clampedSec });
        return;
      }
      if (!Number.isFinite(attemptOrDelaySec)) return;
      send({ name: 'setSubtitleDelay', delaySec: Math.max(-30, Math.min(30, attemptOrDelaySec)) });
    },
    setAudioDevice: (device) => send({ name: 'setAudioDevice', device }),
    getAudioDevices: () => audioDevices,
    getActiveAudioDevice: () => activeAudioDevice,
    onAudioDevicesChange(listener) {
      if (released) return () => undefined;
      audioDeviceListeners.add(listener);
      if (audioDevicesEvent) {
        try {
          listener(audioDevicesEvent.devices, audioDevicesEvent.active);
        } catch {
          // isolate audio device subscribers
        }
      }
      return () => {
        audioDeviceListeners.delete(listener);
      };
    },
    setDeinterlace: (enabled) => send({ name: 'setDeinterlace', enabled }),
    setDeinterlaceMode: (mode) => send({ name: 'setDeinterlaceMode', mode }),
    setPitchLock: (lockedOrAttempt, maybeLocked) => {
      const locked = typeof lockedOrAttempt === 'boolean' ? lockedOrAttempt : Boolean(maybeLocked);
      send({ name: 'setPitchLock', locked });
    },
    setAudioNormalization: (enabled) => send({ name: 'setAudioNormalization', enabled }),
    queueNext: (request) => send({ name: 'queueNext', request }),
    clearQueue: () => send({ name: 'clearQueue' }),
    onQueueAdvanced(listener) {
      if (released) return () => undefined;
      queueAdvancedListeners.add(listener);
      return () => {
        queueAdvancedListeners.delete(listener);
      };
    },
    setHwdec: (profile) => send({ name: 'setHwdec', profile }),
    setResizeMode: (mode) => send({ name: 'setResizeMode', mode }),
    setFilterSdh: (enabled) => send({ name: 'setFilterSdh', enabled }),
    setSubtitleFontFamily: (family) => send({ name: 'setSubtitleFontFamily', family }),
    setMediaMetadata: (metadata) => send({ name: 'setMediaMetadata', metadata }),
    onRemoteMediaAction(listener) {
      if (released) return () => undefined;
      remoteMediaActionListeners.add(listener);
      return () => {
        remoteMediaActionListeners.delete(listener);
      };
    },
    setArea(area) {
      if (!released) bridge.setArea({ engineId: id, area });
    },
    release() {
      if (released) return;
      send({ name: 'release' });
      released = true;
      listeners.clear();
      uiListeners.clear();
      audioDeviceListeners.clear();
      queueAdvancedListeners.clear();
      remoteMediaActionListeners.clear();
      for (const offFrame of [...frameUnsubs]) offFrame();
      frameUnsubs.clear();
      offEvent();
      offUi();
      offRemoteAction();
      bridge.close(id).catch(() => undefined);
    },
    subscribe(listener) {
      if (released) return () => undefined;
      listeners.add(listener);
      if (!everSubscribed) {
        everSubscribed = true;
        for (const held of heldEvents.splice(0)) {
          try {
            listener(held);
          } catch {
            // a listener bug must not stop the others
          }
        }
      }
      return () => {
        listeners.delete(listener);
      };
    },
    onUi(listener) {
      if (released) return () => undefined;
      uiListeners.add(listener);
      if (presenter) {
        try {
          listener(presenter);
        } catch {
          // same isolation as deliverUi
        }
      }
      if (fullscreenEvent) {
        try {
          listener(fullscreenEvent);
        } catch {
          // same isolation as deliverUi
        }
      }
      if (audioDevicesEvent) {
        try {
          listener(audioDevicesEvent);
        } catch {
          // same isolation as deliverUi
        }
      }
      return () => {
        uiListeners.delete(listener);
      };
    },
    onFrame(listener) {
      if (released || !bridge.onFrame) return () => undefined;
      const off = bridge.onFrame(id, listener);
      let active = true;
      const cleanup = (): void => {
        if (!active) return;
        active = false;
        frameUnsubs.delete(cleanup);
        off();
      };
      frameUnsubs.add(cleanup);
      return cleanup;
    },
  };
}
