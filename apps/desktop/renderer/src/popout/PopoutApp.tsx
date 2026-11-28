import { type CatalogService, createCoalescedCatalog } from '@elv/data';
import { createPlaybackGuard, type KeymapStore } from '@elv/domain';
import {
  AppProviders,
  createLazyCatalog,
  createProfileScopedCatalog,
  DEFAULT_AUTO_HIDE_OSD_MS,
  KeymapProvider,
  PlayerScreen,
  type PlayTarget,
  type ProfileCatalogScope,
  ProfileProvider,
  SESSION_GUARD_CHANNEL,
  SESSION_GUARD_STORAGE_KEY,
  usePreferences,
  useProfile,
  type VideoHost,
} from '@elv/features';
import { resolveLocale } from '@elv/i18n';
import { UiAdaptersProvider, useTheme } from '@elv/ui-kit';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc.ts';
import type { PopoutLaunchPayload, WindowBridge } from '../../../src/shared/window-ipc.ts';
import { attachMouseBackGuard } from '../browser-back.ts';
import { createDesktopCatalog } from '../catalog/index.ts';
import { createDesktopVideoHost } from '../player/desktop-video-host.tsx';
import { attachScrollBlurGuard } from '../scroll-blur-guard.ts';
import { createDesktopKeymapStore } from '../storage/keymap.ts';
import { createDesktopPreferencesStore } from '../storage/preferences.ts';
import { attachDeadHostOnlineReset, createDesktopUiAdapters } from '../ui/desktop-adapters.tsx';
import {
  buildPlayTargetFromPopoutLaunch,
  buildPopoutDockPayloadFromTarget,
} from './popout-controller.ts';

const EMPTY_EXCLUDED_SOURCES: ReadonlySet<string> = new Set<string>();

type IncomingSessionGuardEvent =
  | { readonly type: 'parental-relock'; readonly profileId?: string }
  | { readonly type: 'profile-switch'; readonly profileId?: string }
  | { readonly type: 'source-deleted'; readonly sourceId: string };

function parseSessionGuardEvent(raw: unknown): IncomingSessionGuardEvent | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rec = raw as { type?: unknown; profileId?: unknown; sourceId?: unknown };
  const type = rec.type;
  if (type === 'parental-relock' || type === 'profile-switch') {
    const profileId = typeof rec.profileId === 'string' ? rec.profileId : undefined;
    return profileId !== undefined ? { type, profileId } : { type };
  }
  if (type === 'source-deleted' && typeof rec.sourceId === 'string' && rec.sourceId.length > 0) {
    return { type, sourceId: rec.sourceId };
  }
  return null;
}

/** Props of {@link PopoutPlayerStage}. */
export interface PopoutPlayerStageProps {
  readonly catalog: CatalogService;
  readonly videoHost: VideoHost;
  readonly windowBridge: WindowBridge | undefined;
  readonly catalogBridge?: Pick<CatalogBridge, 'onChanged'> | undefined;
}

interface PopoutSessionState {
  readonly key: number;
  readonly target: PlayTarget;
  readonly adoptEngineId?: string;
}

/**
 * Full-featured standalone Desktop Popout player stage (`#158`, Wave P3):
 * mounts the complete `<PlayerScreen>` with zero-reload live engine adoption (`adoptEngineId`),
 * full user preferences, volume slider, timeshift/cache seek, tracks, subtitles, `⋮` overflow
 * menu, channel drawer, zero-reload Dock-back handoff, and cross-window parental relock,
 * profile-switch, and source-deletion teardown.
 */
export function PopoutPlayerStage({
  catalog,
  videoHost,
  windowBridge,
  catalogBridge,
}: PopoutPlayerStageProps): ReactElement {
  const theme = useTheme();
  const preferences = usePreferences();
  const profile = useProfile();
  const prefs = preferences.preferences;
  const [session, setSession] = useState<PopoutSessionState | null>(null);
  const [excludedSourceIds, setExcludedSourceIds] = useState<ReadonlySet<string> | undefined>(() =>
    typeof catalog.listSources === 'function' ? undefined : EMPTY_EXCLUDED_SOURCES,
  );
  const closingRef = useRef(false);
  const mountedRef = useRef(true);
  const pendingRelockRef = useRef<{ readonly profileId?: string } | null>(null);
  const sessionRef = useRef<PopoutSessionState | null>(session);
  sessionRef.current = session;
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const profileScopeRef = useRef<ProfileCatalogScope>({
    profileId: profile.activeProfileId,
    parentalUnlocked: profile.parentalUnlocked === true,
    parentalLoadError: profile.parentalLoadError === true,
    ...(excludedSourceIds !== undefined ? { excludedSourceIds } : {}),
  });
  profileScopeRef.current = {
    profileId: profile.activeProfileId,
    parentalUnlocked: profile.parentalUnlocked === true,
    parentalLoadError: profile.parentalLoadError === true,
    ...(excludedSourceIds !== undefined ? { excludedSourceIds } : {}),
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const scopedCatalog = useMemo(
    () => createProfileScopedCatalog(catalog, () => profileScopeRef.current),
    [catalog],
  );

  const handleTargetChange = useCallback((nextTarget: PlayTarget): void => {
    setSession((prev) => (prev ? { ...prev, target: nextTarget } : null));
  }, []);

  const handleDockPopout = useCallback(
    (target: PlayTarget, positionMs?: number, transferEngineId?: string): void => {
      if (closingRef.current) return;
      closingRef.current = true;
      const dockPayload = buildPopoutDockPayloadFromTarget(target, positionMs, transferEngineId);
      if (windowBridge) {
        void windowBridge.dockPopout(dockPayload).catch(() => undefined);
      }
    },
    [windowBridge],
  );

  const handleExit = useCallback((): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    void windowBridge?.closePopout().catch(() => undefined);
  }, [windowBridge]);

  const playbackGuard = useMemo(
    () =>
      createPlaybackGuard((deletedSourceId) => {
        if (sessionRef.current?.target.sourceId === deletedSourceId) {
          sessionRef.current = null;
          setSession(null);
          handleExit();
        }
      }),
    [handleExit],
  );

  const stopAndExit = useCallback((): void => {
    const sid = sessionRef.current?.target.sourceId;
    sessionRef.current = null;
    setSession(null);
    if (sid) {
      void playbackGuard.stopIfUsingSource(sid);
    }
    handleExit();
  }, [handleExit, playbackGuard]);

  const validateTargetAccess = useCallback(
    (target: PlayTarget, overrideProfileId?: string): void => {
      if (profileRef.current.parentalLoadError === true) {
        stopAndExit();
        return;
      }
      const lockedOpts = {
        profileId: overrideProfileId ?? profileRef.current.activeProfileId,
        parentalUnlocked: false,
      };
      const checkPromise =
        target.catchup !== undefined &&
        typeof catalog.resolveCatchupStream === 'function' &&
        typeof scopedCatalog.resolveCatchupStream === 'function'
          ? scopedCatalog.resolveCatchupStream(
              target.itemKey,
              {
                startMs: target.catchup.startMs,
                stopMs: target.catchup.stopMs,
                ...(target.catchup.hasArchive !== undefined
                  ? { hasArchive: target.catchup.hasArchive }
                  : {}),
                title: target.catchup.programmeTitle,
              },
              lockedOpts,
            )
          : typeof catalog.resolveStream === 'function'
            ? scopedCatalog.resolveStream(target.itemKey, lockedOpts)
            : null;
      if (!checkPromise) return;
      const itemKeySnapshot = target.itemKey;
      void checkPromise
        .then((res) => {
          if (!mountedRef.current || sessionRef.current?.target.itemKey !== itemKeySnapshot) return;
          if (!res.ok) {
            stopAndExit();
          }
        })
        .catch(() => {
          if (mountedRef.current && sessionRef.current?.target.itemKey === itemKeySnapshot) {
            stopAndExit();
          }
        });
    },
    [catalog, scopedCatalog, stopAndExit],
  );

  const applyLaunchPayload = useCallback(
    (next: PopoutLaunchPayload): void => {
      const target = buildPlayTargetFromPopoutLaunch(next);
      if (profileRef.current.parentalLoadError === true) {
        stopAndExit();
        return;
      }
      const pendingRelock = pendingRelockRef.current;
      pendingRelockRef.current = null;
      closingRef.current = false;
      const nextSession: PopoutSessionState = {
        key: (sessionRef.current?.key ?? 0) + 1,
        target,
        ...(next.transferEngineId !== undefined ? { adoptEngineId: next.transferEngineId } : {}),
      };
      sessionRef.current = nextSession;
      setSession(nextSession);
      if (pendingRelock !== null || profileRef.current.parentalUnlocked !== true) {
        validateTargetAccess(target, pendingRelock?.profileId);
      }
    },
    [stopAndExit, validateTargetAccess],
  );

  useEffect(() => {
    if (!windowBridge) return;
    let active = true;
    void windowBridge
      .getPopoutPayload()
      .then((initial) => {
        if (active && initial) applyLaunchPayload(initial);
      })
      .catch(() => undefined);
    const offPayload = windowBridge.onPopoutPayload((next) => {
      if (active) applyLaunchPayload(next);
    });
    return () => {
      active = false;
      offPayload();
    };
  }, [applyLaunchPayload, windowBridge]);

  // Keep excludedSourceIds synced with active profile for profile-scoped catalog queries.
  useEffect(() => {
    if (typeof catalog.listSources !== 'function') {
      setExcludedSourceIds(EMPTY_EXCLUDED_SOURCES);
      return;
    }
    let active = true;
    void catalog
      .listSources()
      .then((sources) => {
        if (!active) return;
        const excluded = new Set<string>();
        for (const s of sources) {
          if (s.excludedProfileIds?.includes(profile.activeProfileId)) {
            excluded.add(s.id);
          }
        }
        setExcludedSourceIds(excluded);
      })
      .catch(() => {
        if (active) setExcludedSourceIds(undefined);
      });
    return () => {
      active = false;
    };
  }, [catalog, profile.activeProfileId, profile.profileRevision]);

  // Fail closed immediately if local profile/parental storage becomes unreadable.
  useEffect(() => {
    if (profile.parentalLoadError === true) {
      stopAndExit();
    }
  }, [profile.parentalLoadError, stopAndExit]);

  // Cross-window session guard (BroadcastChannel primary + localStorage storage-event fallback).
  useEffect(() => {
    let active = true;
    const handleGuardEvent = (event: IncomingSessionGuardEvent): void => {
      if (!active) return;
      if (event.type === 'profile-switch') {
        stopAndExit();
        return;
      }
      if (event.type === 'source-deleted') {
        void playbackGuard.stopIfUsingSource(event.sourceId);
        return;
      }
      profileRef.current.lockParentalNow?.();
      if (profileRef.current.parentalLoadError === true) {
        stopAndExit();
        return;
      }
      const current = sessionRef.current;
      if (!current) {
        pendingRelockRef.current =
          event.profileId !== undefined ? { profileId: event.profileId } : {};
        return;
      }
      validateTargetAccess(current.target, event.profileId);
    };

    interface BroadcastChannelLike {
      onmessage: ((event: { data: unknown }) => void) | null;
      close(): void;
    }
    const host = globalThis as unknown as {
      BroadcastChannel?: new (name: string) => BroadcastChannelLike;
      addEventListener?: (
        type: string,
        listener: (e: { key?: string; newValue?: string | null }) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        listener: (e: { key?: string; newValue?: string | null }) => void,
      ) => void;
    };

    let channel: BroadcastChannelLike | null = null;
    if (typeof host.BroadcastChannel === 'function') {
      try {
        channel = new host.BroadcastChannel(SESSION_GUARD_CHANNEL);
        channel.onmessage = (msg) => {
          const parsed = parseSessionGuardEvent(msg.data);
          if (parsed) handleGuardEvent(parsed);
        };
      } catch {
        channel = null;
      }
    }

    const onStorage = (ev: { key?: string; newValue?: string | null }): void => {
      if (ev.key !== SESSION_GUARD_STORAGE_KEY || typeof ev.newValue !== 'string') return;
      try {
        const parsed = parseSessionGuardEvent(JSON.parse(ev.newValue));
        if (parsed) handleGuardEvent(parsed);
      } catch {
        // Ignore malformed storage payloads.
      }
    };
    const hasStorageListener =
      typeof host.addEventListener === 'function' && typeof host.removeEventListener === 'function';
    if (hasStorageListener) {
      host.addEventListener?.('storage', onStorage);
    }

    return () => {
      active = false;
      channel?.close();
      if (hasStorageListener) {
        host.removeEventListener?.('storage', onStorage);
      }
    };
  }, [playbackGuard, stopAndExit, validateTargetAccess]);

  // Also close Popout if the playing source disappears or becomes excluded during a catalog mutation.
  const effectiveCatalogBridge =
    catalogBridge ?? (typeof window === 'undefined' ? undefined : window.elv?.catalog);
  useEffect(() => {
    if (!effectiveCatalogBridge || typeof effectiveCatalogBridge.onChanged !== 'function') {
      return;
    }
    let active = true;
    const unsub = effectiveCatalogBridge.onChanged(() => {
      if (!active || typeof catalog.listSources !== 'function') return;
      void catalog
        .listSources()
        .then((sources) => {
          if (!active) return;
          const excluded = new Set<string>();
          for (const s of sources) {
            if (s.excludedProfileIds?.includes(profileRef.current.activeProfileId)) {
              excluded.add(s.id);
            }
          }
          setExcludedSourceIds(excluded);
          const sid = sessionRef.current?.target.sourceId;
          if (!sid) return;
          if (!sources.some((s) => s.id === sid) || excluded.has(sid)) {
            void playbackGuard.stopIfUsingSource(sid);
          }
        })
        .catch(() => {
          if (active) setExcludedSourceIds(undefined);
        });
    });
    return () => {
      active = false;
      unsub();
    };
  }, [catalog, effectiveCatalogBridge, playbackGuard]);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bgCanvas }]} testID="popout-root">
      {session ? (
        <PlayerScreen
          key={session.key}
          catalog={scopedCatalog}
          videoHost={videoHost}
          target={session.target}
          viewMode="full"
          playbackGuard={playbackGuard}
          autoHideOsdMs={DEFAULT_AUTO_HIDE_OSD_MS}
          autoEnterPip={prefs.autoEnterPip}
          multiViewSupported={false}
          initialVolume={prefs.playerVolume}
          onPersistVolume={(playerVolume) => {
            void preferences.updatePreferences({ playerVolume });
          }}
          autoSubtitlesOnSkipBack={false}
          autoPlayNextEpisode={prefs.autoPlayNextEpisode}
          onToggleAutoPlayNextEpisode={() => {
            void preferences.updatePreferences({
              autoPlayNextEpisode: !prefs.autoPlayNextEpisode,
            });
          }}
          reduceMotion={prefs.reduceMotion}
          bufferPreset={prefs.bufferPreset}
          useTextureView={prefs.useTextureView}
          seekStepSec={prefs.seekStepSec}
          defaultResizeMode={prefs.defaultResizeMode}
          preferredAudioLang={prefs.preferredAudioLang}
          preferredSubtitleLang={prefs.preferredSubtitleLang}
          preferredAudioLanguages={prefs.preferredAudioLanguages}
          preferredSubtitleLanguages={prefs.preferredSubtitleLanguages}
          preferDefaultAudioTrack={prefs.preferDefaultAudioTrack}
          preferHevcOverDolbyVision={prefs.preferHevcOverDolbyVision}
          filterSdhSubtitles={prefs.filterSdhSubtitles}
          subtitleMode={prefs.subtitleMode}
          subtitleFontFamily={prefs.subtitleFontFamily}
          subtitleStyle={prefs.subtitleStyle}
          onPersistSubtitleStyle={(subtitleStyle) => {
            void preferences.updatePreferences({ subtitleStyle });
          }}
          tvClockMode={prefs.tvClockMode}
          sleepTimerDefaultAction={prefs.sleepTimerDefaultAction}
          onPersistSleepTimerAction={(sleepTimerDefaultAction) => {
            void preferences.updatePreferences({ sleepTimerDefaultAction });
          }}
          stillWatchingTimeoutMin={prefs.stillWatchingTimeoutMin}
          preferredAudioDevice={prefs.preferredAudioDevice}
          onPersistAudioDevice={(preferredAudioDevice) => {
            void preferences.updatePreferences({ preferredAudioDevice });
          }}
          deinterlaceMode={prefs.deinterlaceMode}
          onPersistDeinterlaceMode={(deinterlaceMode) => {
            void preferences.updatePreferences({ deinterlaceMode });
          }}
          pitchLock={prefs.pitchLock}
          onPersistPitchLock={(pitchLock) => {
            void preferences.updatePreferences({ pitchLock });
          }}
          audioNormalization={prefs.audioNormalization}
          onPersistAudioNormalization={(audioNormalization) => {
            void preferences.updatePreferences({ audioNormalization });
          }}
          onPersistTrackLanguagePatch={(patch) => {
            void preferences.updatePreferences(patch);
          }}
          windowAspectRatioLock={prefs.windowAspectRatioLock}
          backgroundAudioPlayback={prefs.backgroundAudioPlayback}
          autoFrameRate={prefs.autoFrameRate}
          autoDynamicRange={prefs.autoDynamicRange}
          nightModeDrc={prefs.nightModeDrc}
          audioDelayByRefreshRateMs={prefs.audioDelayByRefreshRateMs}
          audioPassthrough={prefs.audioPassthrough}
          audioPassthroughCodecs={prefs.audioPassthroughCodecs}
          audioExclusive={prefs.audioExclusive}
          audioAc3Encode={prefs.audioAc3Encode}
          audioChannelLayout={prefs.audioChannelLayout}
          liveChannelSwitchMode={prefs.liveChannelSwitchMode}
          {...(session.adoptEngineId !== undefined ? { adoptEngineId: session.adoptEngineId } : {})}
          onDockPopout={handleDockPopout}
          onTargetChange={handleTargetChange}
          onExit={handleExit}
        />
      ) : null}
    </View>
  );
}

interface PopoutWithKeymapProps extends PopoutPlayerStageProps {
  readonly keymapStore: KeymapStore;
}

function PopoutWithKeymap({
  catalog,
  keymapStore,
  videoHost,
  windowBridge,
  catalogBridge,
}: PopoutWithKeymapProps): ReactElement {
  const profile = useProfile();
  return (
    <KeymapProvider activeProfileId={profile.activeProfileId} keymapStore={keymapStore}>
      <PopoutPlayerStage
        catalog={catalog}
        videoHost={videoHost}
        windowBridge={windowBridge}
        catalogBridge={catalogBridge}
      />
    </KeymapProvider>
  );
}

/** Root mounted by the Electron desktop renderer when opened with `?popout=1` (`#158`, Wave P3). */
export function PopoutApp(): ReactElement {
  const systemLocale = useMemo(() => {
    const languages = typeof navigator === 'undefined' ? [] : navigator.languages;
    return resolveLocale(languages);
  }, []);
  const preferencesStore = useMemo(() => createDesktopPreferencesStore(), []);
  const keymapStore = useMemo(() => createDesktopKeymapStore(), []);
  const uiAdapters = useMemo(() => createDesktopUiAdapters(), []);
  const catalog = useMemo(
    () =>
      createCoalescedCatalog(
        createLazyCatalog(() => createDesktopCatalog()),
        { windowMs: 500 },
      ),
    [],
  );
  const videoHost = useMemo(() => createDesktopVideoHost(), []);
  const windowBridge = typeof window === 'undefined' ? undefined : window.elv?.window;
  const catalogBridge = typeof window === 'undefined' ? undefined : window.elv?.catalog;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const offBack = attachMouseBackGuard(window);
    const offScroll = attachScrollBlurGuard(window);
    const offOnline = attachDeadHostOnlineReset(window);
    return () => {
      offBack();
      offScroll();
      offOnline();
    };
  }, []);

  return (
    <UiAdaptersProvider adapters={uiAdapters}>
      <AppProviders
        keymapStore={keymapStore}
        preferencesStore={preferencesStore}
        profilePreferences={preferencesStore}
        systemLocale={systemLocale}
        viewport={{ formFactor: 'desktop' }}
      >
        <ProfileProvider
          catalog={catalog}
          keymapStore={keymapStore}
          profilePreferences={preferencesStore}
        >
          <PopoutWithKeymap
            catalog={catalog}
            keymapStore={keymapStore}
            videoHost={videoHost}
            windowBridge={windowBridge}
            catalogBridge={catalogBridge}
          />
        </ProfileProvider>
      </AppProviders>
    </UiAdaptersProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    position: 'relative',
    overflow: 'hidden',
  },
});
