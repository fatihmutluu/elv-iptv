import type { AccessibilityFontFamily, DeinterlaceMode } from '@elv/domain';
import type { VideoHost, VideoHostOpenOptions } from '@elv/features';
import type { StreamRequest } from '@elv/playback';
import type {
  PlayerBridge,
  PlayerOpenOptions,
  PresenterKind,
} from '../../../src/shared/player-ipc.ts';
import type { WindowBridge } from '../../../src/shared/window-ipc.ts';
import { bindDesktopMediaSession, createDesktopMediaSession } from '../media-session.ts';
import { createDesktopEngine } from './desktop-engine.ts';
import { type DesktopHostKey, dispatchDesktopClose, routeDesktopUiEvent } from './host-keys.ts';
import { PlayerView } from './PlayerView.tsx';

/** Optional injected collaborators for {@link createDesktopVideoHost}. */
export interface DesktopVideoHostDeps {
  readonly playerBridge?: PlayerBridge | undefined;
  readonly windowBridge?: WindowBridge | undefined;
  readonly presenterKind?: PresenterKind | undefined;
}

/**
 * Creates the desktop renderer {@link VideoHost} backed by `window.elv.player`, supporting
 * Canvas Multi-View (`supportsMultiView`, `replaceExisting`, `primary`, `setMuted`, `setPrimary`)
 * alongside full single-player desktop features (`#34`, `#408`).
 */
export function createDesktopVideoHost(deps?: DesktopVideoHostDeps): VideoHost {
  const mediaSessionOwners = new Set<{ setMediaSessionPrimary(primary: boolean): void }>();
  const resolvePlayerBridge = (): PlayerBridge | undefined =>
    deps && 'playerBridge' in deps
      ? deps.playerBridge
      : typeof window === 'undefined'
        ? undefined
        : window.elv?.player;
  const resolveWindowBridge = (): WindowBridge | undefined =>
    deps && 'windowBridge' in deps
      ? deps.windowBridge
      : typeof window === 'undefined'
        ? undefined
        : window.elv?.window;
  const resolvePresenterKind = (): PresenterKind | undefined =>
    deps && 'presenterKind' in deps
      ? deps.presenterKind
      : typeof window === 'undefined'
        ? undefined
        : window.elv?.presenter;

  return {
    get supportsMultiView(): boolean {
      return resolvePresenterKind() === 'canvas';
    },
    async open(options?: VideoHostOpenOptions) {
      const playerBridge = resolvePlayerBridge();
      if (!playerBridge) return null;
      const openOptions: PlayerOpenOptions | undefined =
        options?.replaceExisting !== undefined || options?.primary !== undefined
          ? {
              ...(options.replaceExisting === undefined
                ? {}
                : { replaceExisting: options.replaceExisting }),
              ...(options.primary === undefined ? {} : { primary: options.primary }),
            }
          : undefined;
      const rawEngine = await createDesktopEngine(
        playerBridge,
        () => performance.now(),
        openOptions,
      );
      const mediaSession = createDesktopMediaSession();
      let activeHostKeyListener: ((key: DesktopHostKey) => void) | null = null;
      let overlayMode: 'floating' | 'docked' = 'floating';
      const overlayModeListeners = new Set<(mode: 'floating' | 'docked') => void>();
      const offPresenterOverlay = rawEngine.onUi((event) => {
        if (event.type !== 'presenter') return;
        const nextMode: 'floating' | 'docked' =
          event.kind === 'canvas' || !event.coversArea ? 'floating' : 'docked';
        if (nextMode === overlayMode) return;
        overlayMode = nextMode;
        for (const listener of [...overlayModeListeners]) {
          try {
            listener(nextMode);
          } catch {
            // isolate overlay mode subscribers
          }
        }
      });
      const windowBridge = resolveWindowBridge();
      let alwaysOnTop = windowBridge
        ? await windowBridge.getAlwaysOnTop().catch(() => false)
        : false;
      const alwaysOnTopListeners = new Set<(pinned: boolean) => void>();
      const notifyAlwaysOnTop = (pinned: boolean): void => {
        if (alwaysOnTop === pinned) return;
        alwaysOnTop = pinned;
        for (const listener of [...alwaysOnTopListeners]) {
          try {
            listener(pinned);
          } catch {
            // isolate always-on-top subscribers
          }
        }
      };
      let offWindowAlwaysOnTop = windowBridge?.onAlwaysOnTopChanged((pinned) => {
        notifyAlwaysOnTop(pinned);
      });
      const initialPrimary = options?.primary !== false;
      if (initialPrimary) {
        for (const owner of mediaSessionOwners) owner.setMediaSessionPrimary(false);
      }
      const boundEngine = bindDesktopMediaSession(rawEngine, mediaSession, {
        initialPrimary,
        onTrackStep: (dir) =>
          activeHostKeyListener?.(dir === 'next' ? 'channel-up' : 'channel-down'),
      });
      const ownerHandle = {
        setMediaSessionPrimary: (primary: boolean) => boundEngine.setMediaSessionPrimary(primary),
      };
      mediaSessionOwners.add(ownerHandle);
      const promotePrimary = (): void => {
        for (const owner of mediaSessionOwners) {
          if (owner !== ownerHandle) owner.setMediaSessionPrimary(false);
        }
        ownerHandle.setMediaSessionPrimary(true);
        rawEngine.setPrimary();
      };
      const engine = {
        ...boundEngine,
        setPrimary: promotePrimary,
        release() {
          mediaSessionOwners.delete(ownerHandle);
          offPresenterOverlay();
          overlayModeListeners.clear();
          offWindowAlwaysOnTop?.();
          offWindowAlwaysOnTop = undefined;
          alwaysOnTopListeners.clear();
          boundEngine.release();
        },
      };
      return {
        engine,
        get overlayMode(): 'floating' | 'docked' {
          return overlayMode;
        },
        onOverlayModeChange: (listener: (mode: 'floating' | 'docked') => void) => {
          overlayModeListeners.add(listener);
          return () => {
            overlayModeListeners.delete(listener);
          };
        },
        renderSurface: ({
          failed,
          resizeMode,
        }: {
          failed: boolean;
          resizeMode?: 'fit' | 'fill' | 'stretch';
        }) => <PlayerView engine={engine} status="" failed={failed} resizeMode={resizeMode} />,
        toggleFullscreen: () => rawEngine.toggleFullscreen(),
        isFullscreen: () => rawEngine.isFullscreen(),
        onFullscreenChange: (listener: (fullscreen: boolean) => void) => {
          let last: boolean | undefined;
          return rawEngine.onUi((event) => {
            if (event.type !== 'fullscreen-changed' || event.fullscreen === last) return;
            last = event.fullscreen;
            listener(event.fullscreen);
          });
        },
        toggleMute: () => rawEngine.toggleMute(),
        setMuted: (muted: boolean) => rawEngine.setMuted(muted),
        setPrimary: promotePrimary,
        setVolume: (volume: number) => rawEngine.setVolume(volume),
        setDeinterlace: (enabled: boolean) => rawEngine.setDeinterlace(enabled),
        setDeinterlaceMode: (mode: DeinterlaceMode) => rawEngine.setDeinterlaceMode(mode),
        setPitchLock: (locked: boolean) => rawEngine.setPitchLock(locked),
        setAudioNormalization: (enabled: boolean) => rawEngine.setAudioNormalization(enabled),
        queueNext: (request: {
          readonly itemKey: string;
          readonly stream: StreamRequest;
          readonly preferHevcOverDolbyVision?: boolean;
          readonly filterSdhSubtitles?: boolean;
        }) => rawEngine.queueNext(request),
        clearQueue: () => rawEngine.clearQueue(),
        onQueueAdvanced: (listener: (itemKey: string) => void) =>
          rawEngine.onQueueAdvanced(listener),
        setResizeMode: (mode: 'fit' | 'fill' | 'stretch') => rawEngine.setResizeMode(mode),
        setFilterSdh: (enabled: boolean) => rawEngine.setFilterSdh(enabled),
        setSubtitleFontFamily: (family: AccessibilityFontFamily) =>
          rawEngine.setSubtitleFontFamily(family),
        ...(playerBridge.pickSubtitleFile
          ? {
              pickSubtitleFile: () => playerBridge.pickSubtitleFile?.() ?? Promise.resolve(null),
            }
          : {}),
        setMediaMetadata: (metadata: Parameters<typeof engine.setMediaMetadata>[0]) =>
          engine.setMediaMetadata(metadata),
        getAudioDevices: () => rawEngine.getAudioDevices(),
        getActiveAudioDevice: () => rawEngine.getActiveAudioDevice(),
        setAudioDevice: (name: string) => rawEngine.setAudioDevice(name),
        onAudioDevicesChange: (listener: Parameters<typeof rawEngine.onAudioDevicesChange>[0]) =>
          rawEngine.onAudioDevicesChange(listener),
        ...(windowBridge
          ? {
              toggleAlwaysOnTop: () => {
                void windowBridge
                  .setAlwaysOnTop(!alwaysOnTop)
                  .then((pinned) => notifyAlwaysOnTop(pinned))
                  .catch(() => undefined);
              },
              isAlwaysOnTop: () => alwaysOnTop,
              onAlwaysOnTopChange: (listener: (pinned: boolean) => void) => {
                alwaysOnTopListeners.add(listener);
                return () => {
                  alwaysOnTopListeners.delete(listener);
                };
              },
            }
          : {}),
        onHostKey: (listener: (key: DesktopHostKey) => void) => {
          activeHostKeyListener = listener;
          const offUi = rawEngine.onUi((event) =>
            routeDesktopUiEvent(event, {
              toggleFullscreen: () => listener('fullscreen'),
              onHostKey: listener,
              onClose: () => dispatchDesktopClose(listener),
            }),
          );
          return () => {
            if (activeHostKeyListener === listener) activeHostKeyListener = null;
            offUi();
          };
        },
      };
    },
  };
}
