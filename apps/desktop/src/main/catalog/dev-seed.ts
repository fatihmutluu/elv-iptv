import type { ImportSummary, SourceRow } from '@elv/data';
import type { Result, SecretStore } from '@elv/domain';
import {
  type CatalogClientMessage,
  type CatalogRpcMethodCall,
  isCatalogWorkerMessage,
} from '../../shared/catalog-ipc.ts';
import type { CatalogCoordinator } from './coordinator.ts';

/** Normalized development source seed parsed from Electron main's `process.env` (#10). */
export type DevSeedPayload =
  | {
      readonly kind: 'xtream';
      readonly name: string;
      readonly server: string;
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly kind: 'm3u';
      readonly name: string;
      readonly playlistUrl: string;
      readonly guideUrl?: string;
    };

/** Subset of Electron's `MessagePortMain` used by {@link runDesktopDevSeedOnce}. */
export interface DevSeedPortLike {
  on(event: 'message', listener: (messageEvent: { readonly data: unknown }) => void): unknown;
  off(event: 'message', listener: (messageEvent: { readonly data: unknown }) => void): unknown;
  postMessage(message: CatalogClientMessage): void;
  start(): void;
  close(): void;
}

function defaultHostName(rawUrl: string, fallback: string): string {
  try {
    return new URL(rawUrl).host || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Parses `DEV_XTREAM_*` or `DEV_M3U_URL` from `env` strictly in unpackaged development builds.
 * Returns `undefined` when `options.isPackaged` is `true` or no complete dev source is configured.
 */
export function parseDevSeedEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly isPackaged?: boolean } = {},
): DevSeedPayload | undefined {
  if (options.isPackaged === true) {
    return undefined;
  }

  const server = (env.DEV_XTREAM_SERVER ?? env.DEV_XTREAM_URL ?? '').trim();
  const username = (env.DEV_XTREAM_USERNAME ?? '').trim();
  const password = (env.DEV_XTREAM_PASSWORD ?? '').trim();
  if (server !== '' && username !== '' && password !== '') {
    const customName = (env.DEV_XTREAM_NAME ?? env.DEV_SOURCE_NAME ?? '').trim();
    return {
      kind: 'xtream',
      name: customName !== '' ? customName : defaultHostName(server, 'Dev Xtream'),
      server,
      username,
      password,
    };
  }

  const playlistUrl = (env.DEV_M3U_URL ?? '').trim();
  if (playlistUrl !== '') {
    const customName = (env.DEV_M3U_NAME ?? env.DEV_SOURCE_NAME ?? '').trim();
    const guideUrl = (env.DEV_M3U_GUIDE_URL ?? env.DEV_GUIDE_URL ?? '').trim();
    return {
      kind: 'm3u',
      name: customName !== '' ? customName : defaultHostName(playlistUrl, 'Dev M3U'),
      playlistUrl,
      ...(guideUrl !== '' ? { guideUrl } : {}),
    };
  }

  return undefined;
}

function createPortCaller(port: DevSeedPortLike): {
  call<T>(rpc: CatalogRpcMethodCall): Promise<T>;
  dispose(): void;
} {
  let nextReqId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();

  const onMessage = (event: { readonly data: unknown }): void => {
    const raw = event.data;
    if (!isCatalogWorkerMessage(raw) || raw.type === 'progress') return;
    const entry = pending.get(raw.reqId);
    if (!entry) return;
    pending.delete(raw.reqId);
    if (raw.type === 'result') {
      entry.resolve(raw.value);
    } else {
      entry.reject(new Error(`catalog worker fault: ${raw.error.category}/${raw.error.code}`));
    }
  };

  port.on('message', onMessage);
  port.start();

  return {
    call<T>(rpc: CatalogRpcMethodCall): Promise<T> {
      const reqId = ++nextReqId;
      return new Promise<T>((resolve, reject) => {
        pending.set(reqId, {
          resolve: (val) => resolve(val as T),
          reject,
        });
        port.postMessage({ type: 'call', reqId, call: rpc });
      });
    },
    dispose(): void {
      port.off('message', onMessage);
      for (const entry of pending.values()) {
        entry.reject(new Error('dev seed port disposed'));
      }
      pending.clear();
      port.close();
    },
  };
}

/**
 * Seeds the developer's `.env.local` source once in Electron main via a temporary client port on
 * {@link CatalogCoordinator}, without exposing any `DEV_*` variable to the renderer (#10).
 */
export async function runDesktopDevSeedOnce(deps: {
  seed: DevSeedPayload | undefined;
  coordinator: Pick<CatalogCoordinator<DevSeedPortLike>, 'connectClient' | 'disconnectClient'>;
  secrets: Pick<SecretStore, 'get' | 'set'>;
}): Promise<{ seeded: boolean; sourceId?: string }> {
  const seededKey = 'elv.dev.seeded';
  if (deps.seed === undefined) {
    return { seeded: false };
  }

  const alreadySeeded = await deps.secrets.get(seededKey);
  if (alreadySeeded === '1') {
    return { seeded: false };
  }

  const { clientId, rendererPort } = await deps.coordinator.connectClient();
  const caller = createPortCaller(rendererPort);
  try {
    const existing = await caller.call<SourceRow[]>({ method: 'listSources' });
    if (existing.length > 0) {
      await deps.secrets.set(seededKey, '1');
      return { seeded: false };
    }

    const added =
      deps.seed.kind === 'xtream'
        ? await caller.call<Result<SourceRow>>({
            method: 'addSource',
            input: {
              kind: 'xtream',
              name: deps.seed.name,
              server: deps.seed.server,
              username: deps.seed.username,
              password: deps.seed.password,
            },
          })
        : await caller.call<Result<SourceRow>>({
            method: 'addSourceFromLink',
            input: {
              name: deps.seed.name,
              url: deps.seed.playlistUrl,
              ...(deps.seed.guideUrl !== undefined ? { guideUrl: deps.seed.guideUrl } : {}),
            },
          });

    if (!added.ok) {
      return { seeded: false };
    }

    await deps.secrets.set(seededKey, '1');
    await caller.call<Result<ImportSummary>>({ method: 'importSource', id: added.value.id });
    return { seeded: true, sourceId: added.value.id };
  } finally {
    caller.dispose();
    deps.coordinator.disconnectClient(clientId);
  }
}
