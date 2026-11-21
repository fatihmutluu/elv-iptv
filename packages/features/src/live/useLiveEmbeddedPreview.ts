import {
  type CatalogService,
  type ItemRow,
  resolveAccountPoolKey,
  type SourceRow,
} from '@elv/data';
import {
  createMonotonicClock,
  createPlaybackService,
  type PlaybackService,
  type PlaybackTimers,
} from '@elv/playback';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlaybackGuard } from '../ports/playback-guard';
import type { OpenVideoEngine, VideoHost } from '../ports/video-host';
import { useRouteActive } from '../shared';

const PREVIEW_TIMERS: PlaybackTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function isPromiseLike<T>(v: T | Promise<T>): v is Promise<T> {
  return (
    typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'
  );
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch {
    /* best-effort teardown */
  }
}

/** Options accepted by {@link useLiveEmbeddedPreview}. */
export interface UseLiveEmbeddedPreviewOptions {
  readonly enabled: boolean;
  readonly activeChannel: ItemRow | null;
  readonly sources: readonly SourceRow[];
  readonly catalog: Pick<CatalogService, 'resolveStream'>;
  readonly videoHost?: VideoHost;
  readonly playbackGuard?: PlaybackGuard;
}

/** Embedded live preview session state returned by {@link useLiveEmbeddedPreview}. */
export interface LiveEmbeddedPreviewState {
  readonly opened: OpenVideoEngine | null;
  readonly statusText: string;
  readonly failed: boolean;
  readonly stopAndRelease: () => Promise<void>;
}

interface ActivePreviewSession {
  readonly opened: OpenVideoEngine;
  readonly service: PlaybackService;
  readonly unsubService: () => void;
  readonly unregGuard?: () => void;
}

/**
 * Single-connection-safe embedded live preview hook for `LiveWatchStage` (`Favorites` mode):
 * opens `videoHost` once per session, zaps favorites on the same engine, registers with
 * `playbackGuard`, recovers cleanly on surviving sources after source removal, and stops+releases
 * before fullscreen handoff, mode leave, route freeze/background, or unmount.
 */
export function useLiveEmbeddedPreview(
  opts: UseLiveEmbeddedPreviewOptions,
): LiveEmbeddedPreviewState {
  const { enabled, activeChannel, sources, catalog, videoHost, playbackGuard } = opts;
  const isRouteActive = useRouteActive();

  const [opened, setOpened] = useState<OpenVideoEngine | null>(null);
  const [statusUi, setStatusUi] = useState({ statusText: '', failed: false });
  const [reopenSeq, setReopenSeq] = useState(0);
  const sessionRef = useRef<ActivePreviewSession | null>(null);
  const sessionGenRef = useRef(0);
  const tunedKeyRef = useRef<string | null>(null);
  const handoffReleasedRef = useRef(false);
  const guardStoppedSourceRef = useRef<string | null>(null);
  const refs = useRef({ activeChannel, sources, catalog });
  refs.current = { activeChannel, sources, catalog };

  const tuneChannelOnService = useCallback((service: PlaybackService, ch: ItemRow): void => {
    const src = refs.current.sources.find((s) => s.id === ch.sourceId);
    tunedKeyRef.current = ch.key;
    service.tune({
      item: ch.key,
      accountKey: src ? resolveAccountPoolKey(src) : ch.sourceId,
      kind: 'live',
      resolve: () => refs.current.catalog.resolveStream(ch.key),
    });
  }, []);

  const tearDownSession = useCallback(async (markHandoff: boolean): Promise<void> => {
    sessionGenRef.current += 1;
    tunedKeyRef.current = null;
    if (markHandoff) handoffReleasedRef.current = true;
    const current = sessionRef.current;
    sessionRef.current = null;
    setOpened(null);
    setStatusUi({ statusText: '', failed: false });
    if (current === null) return;
    current.unregGuard?.();
    current.unsubService();
    safeCall(() => current.service.stop());
    safeCall(() => current.service.dispose());
    try {
      await Promise.resolve(current.opened.engine.release());
    } catch {
      /* best-effort release so callers (e.g. fullscreen handoff) are never blocked */
    }
  }, []);

  const stopAndRelease = useCallback(() => tearDownSession(true), [tearDownSession]);
  const shouldOpen = enabled && activeChannel !== null && videoHost !== undefined && isRouteActive;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reopenSeq deliberately re-opens preview when a surviving source replaces a guard-stopped source
  useEffect(() => {
    if (!shouldOpen || videoHost === undefined) {
      handoffReleasedRef.current = false;
      guardStoppedSourceRef.current = null;
      void tearDownSession(false);
      return undefined;
    }
    if (handoffReleasedRef.current) return undefined;

    const gen = ++sessionGenRef.current;
    const attachOpened = (nextOpened: OpenVideoEngine | null): void => {
      if (sessionGenRef.current !== gen) {
        if (nextOpened !== null) safeCall(() => void nextOpened.engine.release());
        return;
      }
      if (nextOpened === null) {
        setOpened(null);
        return;
      }
      const service = createPlaybackService({
        engine: nextOpened.engine,
        clock: createMonotonicClock(),
        timers: PREVIEW_TIMERS,
      });
      const unsubService = service.subscribe(() => {
        if (sessionGenRef.current !== gen) return;
        const { status } = service.getState();
        const failed = status.kind === 'failed';
        const statusText = status.kind === 'playing' ? '' : status.kind;
        setStatusUi((p) =>
          p.statusText === statusText && p.failed === failed ? p : { statusText, failed },
        );
      });
      const unregGuard = playbackGuard?.registerSession?.({
        getSourceId: () => refs.current.activeChannel?.sourceId,
        stop: () => {
          guardStoppedSourceRef.current = refs.current.activeChannel?.sourceId ?? null;
          void tearDownSession(false);
        },
      });
      sessionRef.current = {
        opened: nextOpened,
        service,
        unsubService,
        ...(unregGuard !== undefined ? { unregGuard } : {}),
      };
      setOpened(nextOpened);
      if (refs.current.activeChannel !== null) {
        tuneChannelOnService(service, refs.current.activeChannel);
      }
    };

    try {
      const result = videoHost.open();
      if (isPromiseLike(result)) {
        result.then(attachOpened, () => {
          if (sessionGenRef.current === gen) setOpened(null);
        });
      } else {
        attachOpened(result);
      }
    } catch {
      if (sessionGenRef.current === gen) setOpened(null);
    }

    return () => {
      void tearDownSession(false);
    };
  }, [playbackGuard, reopenSeq, shouldOpen, tearDownSession, tuneChannelOnService, videoHost]);

  useEffect(() => {
    if (!shouldOpen || activeChannel === null) return;
    const current = sessionRef.current;
    if (current !== null) {
      if (tunedKeyRef.current !== activeChannel.key) {
        tuneChannelOnService(current.service, activeChannel);
      }
      return;
    }
    if (
      !handoffReleasedRef.current &&
      guardStoppedSourceRef.current !== null &&
      activeChannel.sourceId !== guardStoppedSourceRef.current
    ) {
      guardStoppedSourceRef.current = null;
      setReopenSeq((n) => n + 1);
    }
  }, [activeChannel, shouldOpen, tuneChannelOnService]);

  return useMemo<LiveEmbeddedPreviewState>(
    () => ({ opened, ...statusUi, stopAndRelease }),
    [opened, statusUi, stopAndRelease],
  );
}
