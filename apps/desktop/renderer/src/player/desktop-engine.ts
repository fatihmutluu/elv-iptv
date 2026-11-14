import type {
  AttemptToken,
  EngineCapabilities,
  EngineEvent,
  LoadCommand,
  PlayerEngine,
} from '@elv/playback';
import type {
  BridgeCommand,
  PlayerArea,
  PlayerBridge,
  PlayerEventMessage,
  PlayerUiEvent,
  PlayerUiMessage,
} from '../../../src/shared/player-ipc.ts';

/**
 * The renderer's copy of `DESKTOP_CAPABILITIES` (`src/shared/player-ipc.ts`). The renderer imports that module for
 * types only so Metro never resolves it; a test keeps the two equal.
 */
const CAPABILITIES: EngineCapabilities = Object.freeze({
  mpegTsOverHttp: true,
  hls: true,
  liveSeek: false,
  softwareAudioFallback: false,
  recreate: true,
  audioTrackSelection: false,
  subtitleTrackSelection: false,
});

/** The renderer's `PlayerEngine` for the desktop app, plus the presenter's controls. */
export interface DesktopEngine extends PlayerEngine {
  readonly engineId: string;
  /** Tells main where the video belongs, in CSS pixels of the window content. */
  setArea(area: PlayerArea): void;
  /** Toggles the presenter's fullscreen (not a port command). */
  toggleFullscreen(): void;
  /** Presentation events outside the port; the latest `presenter` event is replayed to a new listener. */
  onUi(listener: (event: PlayerUiEvent) => void): () => void;
}

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
  let engineId: string | undefined;
  let offset = 0;
  let released = false;
  let presenter: Extract<PlayerUiEvent, { type: 'presenter' }> | undefined;
  const earlyEvents: PlayerEventMessage[] = [];
  const earlyUi: PlayerUiMessage[] = [];

  const deliverEvent = (event: EngineEvent): void => {
    const mapped = shiftAnchor(event, offset);
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
    for (const listener of [...uiListeners]) {
      try {
        listener(ui);
      } catch {
        // same isolation as engine listeners
      }
    }
  };

  const offEvent = bridge.onEvent((message) => {
    if (engineId === undefined) earlyEvents.push(message);
    else if (message.engineId === engineId) deliverEvent(message.event);
  });
  const offUi = bridge.onUi((message) => {
    if (engineId === undefined) earlyUi.push(message);
    else if (message.engineId === engineId) deliverUi(message.ui);
  });

  const t0 = now();
  let reply: Awaited<ReturnType<PlayerBridge['open']>>;
  try {
    reply = await bridge.open();
  } catch (error) {
    offEvent();
    offUi();
    throw error;
  }
  offset = (t0 + now()) / 2 - reply.mainNowMs;
  engineId = reply.engineId;
  const id = reply.engineId;
  for (const m of earlyUi.splice(0)) if (m.engineId === id) deliverUi(m.ui);
  for (const m of earlyEvents.splice(0)) if (m.engineId === id) deliverEvent(m.event);

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
    stop: (attempt) => send({ name: 'stop', attempt }),
    recreate: (attempt) => send({ name: 'recreate', attempt }),
    toggleFullscreen: () => send({ name: 'fullscreen' }),
    setArea(area) {
      if (!released) bridge.setArea({ engineId: id, area });
    },
    release() {
      if (released) return;
      send({ name: 'release' });
      released = true;
      listeners.clear();
      uiListeners.clear();
      offEvent();
      offUi();
      bridge.close(id).catch(() => undefined);
    },
    subscribe(listener) {
      if (released) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onUi(listener) {
      if (released) return () => undefined;
      uiListeners.add(listener);
      if (presenter) listener(presenter);
      return () => {
        uiListeners.delete(listener);
      };
    },
  };
}
