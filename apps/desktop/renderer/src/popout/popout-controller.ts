import type {
  DesktopTrayLabels,
  DesktopWindowPort,
  PlayTarget,
  PopoutDockPayload,
  PopoutLaunchPayload,
  ThermalDevicePort,
} from '@elv/features';
import type { WindowBridge } from '../../../src/shared/window-ipc.ts';

/** Returns `true` when the renderer URL query requests the standalone popout player (`?popout=1`). */
export function isPopoutSearch(search: string): boolean {
  if (!search) return false;
  try {
    return new URLSearchParams(search).get('popout') === '1';
  } catch {
    return false;
  }
}

/** Converts a sanitized {@link PopoutLaunchPayload} into a {@link PlayTarget} for `PlayerScreen`. */
export function buildPlayTargetFromPopoutLaunch(payload: PopoutLaunchPayload): PlayTarget {
  return {
    itemKey: payload.itemKey,
    sourceId: payload.sourceId ?? '',
    title: payload.title,
    kind: payload.kind === 'live' ? 'live' : 'vod',
    itemKind: payload.kind,
    ...(payload.subtitle === undefined ? {} : { subtitle: payload.subtitle }),
    ...(payload.logo === undefined ? {} : { logo: payload.logo }),
    ...(payload.resumePositionMs !== undefined &&
    payload.kind !== 'live' &&
    Number.isFinite(payload.resumePositionMs) &&
    payload.resumePositionMs >= 0
      ? { startPositionMs: Math.round(payload.resumePositionMs) }
      : {}),
    ...(payload.isLocalOffline === true && payload.kind !== 'live' ? { isLocalOffline: true } : {}),
    ...(payload.localFileUri && payload.kind !== 'live'
      ? { localFileUri: payload.localFileUri }
      : {}),
  };
}

/** Builds a clean {@link PopoutDockPayload} from an active {@link PlayTarget}, position, and optional parked engine ID. */
export function buildPopoutDockPayloadFromTarget(
  target: PlayTarget,
  positionMs?: number,
  transferEngineId?: string,
): PopoutDockPayload {
  const kind: PopoutDockPayload['kind'] =
    target.kind === 'live' ? 'live' : target.itemKind === 'episode' ? 'episode' : 'movie';
  const validPos =
    kind !== 'live' &&
    typeof positionMs === 'number' &&
    Number.isFinite(positionMs) &&
    positionMs >= 0
      ? Math.round(positionMs)
      : undefined;
  const cleanTransferId =
    typeof transferEngineId === 'string' && transferEngineId.trim().length > 0
      ? transferEngineId.trim()
      : undefined;
  return {
    itemKey: target.itemKey,
    kind,
    title: target.title,
    ...(target.subtitle !== undefined && target.subtitle !== null
      ? { subtitle: target.subtitle }
      : {}),
    ...(target.logo !== undefined && target.logo !== null ? { logo: target.logo } : {}),
    ...(target.sourceId ? { sourceId: target.sourceId } : {}),
    ...(validPos === undefined ? {} : { positionMs: validPos }),
    ...(cleanTransferId === undefined ? {} : { transferEngineId: cleanTransferId }),
    ...(target.isLocalOffline === true && kind !== 'live' ? { isLocalOffline: true } : {}),
    ...(target.localFileUri && kind !== 'live' ? { localFileUri: target.localFileUri } : {}),
  };
}

/** Builds a clean {@link PopoutDockPayload} from the active launch payload and latest playback position. */
export function buildPopoutDockPayload(
  payload: PopoutLaunchPayload,
  positionMs?: number,
  transferEngineId?: string,
): PopoutDockPayload {
  const validPos =
    payload.kind !== 'live' &&
    typeof positionMs === 'number' &&
    Number.isFinite(positionMs) &&
    positionMs >= 0
      ? Math.round(positionMs)
      : undefined;
  const cleanTransferId =
    typeof transferEngineId === 'string' && transferEngineId.trim().length > 0
      ? transferEngineId.trim()
      : undefined;
  return {
    itemKey: payload.itemKey,
    kind: payload.kind,
    title: payload.title,
    ...(payload.subtitle === undefined ? {} : { subtitle: payload.subtitle }),
    ...(payload.logo === undefined ? {} : { logo: payload.logo }),
    ...(payload.sourceId === undefined ? {} : { sourceId: payload.sourceId }),
    ...(validPos === undefined ? {} : { positionMs: validPos }),
    ...(cleanTransferId === undefined ? {} : { transferEngineId: cleanTransferId }),
    ...(payload.isLocalOffline === true && payload.kind !== 'live' ? { isLocalOffline: true } : {}),
    ...(payload.localFileUri && payload.kind !== 'live'
      ? { localFileUri: payload.localFileUri }
      : {}),
  };
}

/** Adapts `window.elv.window` to `@elv/features`'s {@link DesktopWindowPort} (`#158`). */
export function createDesktopWindowPort(
  bridge: WindowBridge | undefined,
): DesktopWindowPort | undefined {
  if (!bridge) return undefined;
  return {
    setMinimizeToTray: async (enabled: boolean, labels?: DesktopTrayLabels) => {
      await (labels === undefined
        ? bridge.setMinimizeToTray(enabled)
        : bridge.setMinimizeToTray(enabled, labels));
    },
    openPopout: (payload: PopoutLaunchPayload) => bridge.openPopout(payload),
    closePopout: () => bridge.closePopout(),
    onPopoutDocked: (listener: (payload: PopoutDockPayload) => void) =>
      bridge.onPopoutDocked(listener),
    onWindowRestored: (listener: () => void) => bridge.onWindowRestored(listener),
    onHiddenToTray: (listener: () => void) => bridge.onHiddenToTray(listener),
  };
}

/** Desktop {@link ThermalDevicePort} reporting `'nominal'` thermal state and desktop Multi-View capability (`#34`, `#232`). */
export function createDesktopThermalDevicePort(): ThermalDevicePort {
  return {
    getThermalState: () => 'nominal',
    subscribeThermalState: () => () => undefined,
    getMultiViewCapabilities: () => ({ platform: 'desktop', supported: true }),
  };
}
