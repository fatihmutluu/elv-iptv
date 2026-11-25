import type {
  DesktopTrayLabels,
  DesktopWindowPort,
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

/** Builds a clean {@link PopoutDockPayload} from the active launch payload and latest playback position. */
export function buildPopoutDockPayload(
  payload: PopoutLaunchPayload,
  positionMs?: number,
): PopoutDockPayload {
  const validPos =
    payload.kind !== 'live' &&
    typeof positionMs === 'number' &&
    Number.isFinite(positionMs) &&
    positionMs >= 0
      ? Math.round(positionMs)
      : undefined;
  return {
    itemKey: payload.itemKey,
    kind: payload.kind,
    title: payload.title,
    ...(payload.subtitle === undefined ? {} : { subtitle: payload.subtitle }),
    ...(payload.logo === undefined ? {} : { logo: payload.logo }),
    ...(payload.sourceId === undefined ? {} : { sourceId: payload.sourceId }),
    ...(validPos === undefined ? {} : { positionMs: validPos }),
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
