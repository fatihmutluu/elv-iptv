import { type CatalogService, computeResumePositionMs, type UserItemKind } from '@elv/data';
import type { ExternalPlayerMode } from '@elv/domain';
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { PlayTarget } from '../ports/play-target';
import type { ExternalPlayerPort, ExternalPlayerResult } from '../ports/wave-f7b-ports';

const ERROR_TOAST_MS = 4_000;

function resolveItemKind(target: PlayTarget): UserItemKind {
  if (target.itemKind !== undefined) return target.itemKind;
  if (target.seriesKey != null || target.season != null || target.episode != null) {
    return 'episode';
  }
  return 'movie';
}

/** Collaborators for {@link runExternalPlayerHandoff}. */
export interface RunExternalPlayerHandoffInput {
  readonly target: PlayTarget;
  readonly catalog: Pick<CatalogService, 'resolveStream'> &
    Partial<Pick<CatalogService, 'getProgress' | 'saveProgress'>>;
  readonly externalPlayer: ExternalPlayerPort;
  readonly customScheme?: string;
  readonly stopEmbeddedPreview?: (() => Promise<void>) | null;
  readonly stopActivePlayer?: (() => Promise<void>) | null;
  readonly onReleaseConnection?: () => void;
  readonly onProgressSaved?: () => void;
}

/**
 * Stops any active preview or fullscreen player FIRST (freeing `max_connections = 1`),
 * resolves the stream URL at play time without logging it, launches the external player,
 * and persists valid VOD watch progress returned by the external player (`#406`).
 */
export async function runExternalPlayerHandoff(
  input: RunExternalPlayerHandoffInput,
): Promise<{ readonly ok: boolean }> {
  const { target, catalog, externalPlayer } = input;
  try {
    if (input.stopEmbeddedPreview != null) {
      await input.stopEmbeddedPreview();
    }
  } catch {
    // Continue teardown even if preview stop threw.
  }
  try {
    if (input.stopActivePlayer != null) {
      await input.stopActivePlayer();
    }
  } catch {
    // Continue teardown even if active player stop threw.
  }
  input.onReleaseConnection?.();

  let resolved: Awaited<ReturnType<CatalogService['resolveStream']>>;
  try {
    resolved = await catalog.resolveStream(target.itemKey);
  } catch {
    return { ok: false };
  }
  if (!resolved.ok) {
    return { ok: false };
  }

  let startPositionMs = 0;
  if (
    target.startPositionMs !== undefined &&
    Number.isFinite(target.startPositionMs) &&
    target.startPositionMs > 0
  ) {
    startPositionMs = Math.round(target.startPositionMs);
  } else if (target.kind === 'vod' && target.catchup === undefined && catalog.getProgress) {
    try {
      const existing = await catalog.getProgress(target.itemKey);
      if (existing !== null) {
        startPositionMs = Math.max(0, computeResumePositionMs(existing));
      }
    } catch {
      startPositionMs = 0;
    }
  }

  const trimmedScheme = input.customScheme?.trim() ?? '';
  let result: ExternalPlayerResult | null | undefined;
  try {
    result = await externalPlayer.launch({
      url: resolved.value.url,
      title: target.title,
      startPositionMs,
      headers: resolved.value.headers,
      ...(trimmedScheme.length > 0 ? { customScheme: trimmedScheme } : {}),
    });
  } catch {
    result = { launched: false, errorCode: 'launch_failed' };
  }

  if (!result?.launched) {
    return { ok: false };
  }

  if (target.kind === 'vod' && target.catchup === undefined && catalog.saveProgress) {
    const completed = result.completed === true;
    const hasValidRange =
      result.positionMs !== undefined &&
      Number.isFinite(result.positionMs) &&
      result.positionMs >= 0 &&
      result.durationMs !== undefined &&
      Number.isFinite(result.durationMs) &&
      result.durationMs > 0;

    if (completed || hasValidRange) {
      const durationMs =
        result.durationMs !== undefined &&
        Number.isFinite(result.durationMs) &&
        result.durationMs > 0
          ? Math.round(result.durationMs)
          : Math.max(0, Math.round(result.positionMs ?? 0));
      const positionMs = completed ? durationMs : Math.max(0, Math.round(result.positionMs ?? 0));
      const watched = completed || (durationMs > 0 && positionMs / durationMs >= 0.9);
      try {
        await catalog.saveProgress({
          sourceId: target.sourceId,
          itemKey: target.itemKey,
          kind: resolveItemKind(target),
          title: target.title,
          subtitle: target.subtitle ?? null,
          logo: target.logo ?? null,
          seriesKey: target.seriesKey ?? null,
          season: target.season ?? null,
          episode: target.episode ?? null,
          positionMs,
          durationMs,
          watched,
        });
        input.onProgressSaved?.();
      } catch {
        // Non-fatal: playback already completed in external app.
      }
    }
  }

  return { ok: true };
}

/** Options for {@link useExternalPlayerHandoff}. */
export interface UseExternalPlayerHandoffOptions {
  readonly mode: ExternalPlayerMode;
  readonly customScheme: string;
  readonly externalPlayer?: ExternalPlayerPort;
  readonly catalog: Pick<CatalogService, 'resolveStream'> &
    Partial<Pick<CatalogService, 'getProgress' | 'saveProgress'>>;
  readonly stopEmbeddedPreviewRef: MutableRefObject<(() => Promise<void>) | null>;
  readonly stopActivePlayerRef: MutableRefObject<(() => Promise<void>) | null>;
  readonly onOpenIntegrated: (target: PlayTarget) => void;
  readonly onReleaseConnection: () => void;
  readonly onProgressSaved: () => void;
}

/** Coordinates opt-in external player prompts, safe connection teardown, and watch-progress return (`#406`). */
export function useExternalPlayerHandoff(options: UseExternalPlayerHandoffOptions) {
  const [promptTarget, setPromptTarget] = useState<PlayTarget | null>(null);
  const [handoffErrorVisible, setHandoffErrorVisible] = useState(false);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    return () => {
      if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current);
    };
  }, []);

  const showHandoffError = useCallback(() => {
    setHandoffErrorVisible(true);
    if (errorTimerRef.current !== null) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      errorTimerRef.current = null;
      setHandoffErrorVisible(false);
    }, ERROR_TOAST_MS);
  }, []);

  const launchExternal = useCallback(
    async (target: PlayTarget) => {
      const cur = optsRef.current;
      if (!cur.externalPlayer?.isSupported) {
        showHandoffError();
        return;
      }
      const res = await runExternalPlayerHandoff({
        target,
        catalog: cur.catalog,
        externalPlayer: cur.externalPlayer,
        customScheme: cur.customScheme,
        stopEmbeddedPreview: cur.stopEmbeddedPreviewRef.current,
        stopActivePlayer: cur.stopActivePlayerRef.current,
        onReleaseConnection: cur.onReleaseConnection,
        onProgressSaved: cur.onProgressSaved,
      });
      if (!res.ok) {
        showHandoffError();
      }
    },
    [showHandoffError],
  );

  const interceptPlayTarget = useCallback(
    (target: PlayTarget) => {
      const cur = optsRef.current;
      if (cur.mode === 'off' || cur.externalPlayer?.isSupported !== true) {
        cur.onOpenIntegrated(target);
        return;
      }
      if (cur.mode === 'ask') {
        setPromptTarget(target);
        return;
      }
      void launchExternal(target);
    },
    [launchExternal],
  );

  const chooseIntegrated = useCallback(() => {
    const target = promptTarget;
    setPromptTarget(null);
    if (target !== null) {
      optsRef.current.onOpenIntegrated(target);
    }
  }, [promptTarget]);

  const chooseExternal = useCallback(() => {
    const target = promptTarget;
    setPromptTarget(null);
    if (target !== null) {
      void launchExternal(target);
    }
  }, [launchExternal, promptTarget]);

  const cancelPrompt = useCallback(() => {
    setPromptTarget(null);
    optsRef.current.onReleaseConnection();
  }, []);

  return {
    promptTarget,
    handoffErrorVisible,
    interceptPlayTarget,
    chooseIntegrated,
    chooseExternal,
    cancelPrompt,
  };
}
