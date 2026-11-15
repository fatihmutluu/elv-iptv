import type { CatalogService } from '@elv/data';
import type { SecretStore } from '@elv/domain';
import type { DevSeedPayload } from '../../config/build-app-config';

export type { DevSeedPayload };

const DEV_SEEDED_KEY = 'elv.dev.seeded';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Extracts a validated {@link DevSeedPayload} from `Constants.expoConfig?.extra`. */
export function readEmbeddedDevSeed(
  extra: Readonly<Record<string, unknown>> | undefined,
): DevSeedPayload | undefined {
  const raw = extra?.seed;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (
    record.kind === 'xtream' &&
    isNonEmptyString(record.name) &&
    isNonEmptyString(record.server) &&
    isNonEmptyString(record.username) &&
    isNonEmptyString(record.password)
  ) {
    return {
      kind: 'xtream',
      name: record.name,
      server: record.server,
      username: record.username,
      password: record.password,
    };
  }
  if (
    record.kind === 'm3u' &&
    isNonEmptyString(record.name) &&
    isNonEmptyString(record.playlistUrl)
  ) {
    const guideUrl = record.guideUrl;
    return {
      kind: 'm3u',
      name: record['name'],
      playlistUrl: record['playlistUrl'],
      ...(isNonEmptyString(guideUrl) ? { guideUrl } : {}),
    };
  }
  return undefined;
}

/**
 * Provisions the developer's `.env.local` source at most once per app install (#10).
 * Persists `elv.dev.seeded = '1'` in `SecretStore` so removing the source later never re-seeds.
 */
export async function runDevSeedOnce(deps: {
  seed: DevSeedPayload | undefined;
  catalog: Pick<CatalogService, 'listSources' | 'addSource' | 'addSourceFromLink' | 'importSource'>;
  secrets: Pick<SecretStore, 'get' | 'set'>;
  onChanged?: () => void;
}): Promise<{ seeded: boolean; sourceId?: string }> {
  if (deps.seed === undefined) {
    return { seeded: false };
  }
  const alreadySeeded = await deps.secrets.get(DEV_SEEDED_KEY);
  if (alreadySeeded === '1') {
    return { seeded: false };
  }

  const existing = await deps.catalog.listSources();
  if (existing.length > 0) {
    await deps.secrets.set(DEV_SEEDED_KEY, '1');
    return { seeded: false };
  }

  const added =
    deps.seed.kind === 'xtream'
      ? await deps.catalog.addSource({
          kind: 'xtream',
          name: deps.seed.name,
          server: deps.seed.server,
          username: deps.seed.username,
          password: deps.seed.password,
        })
      : await deps.catalog.addSourceFromLink({
          name: deps.seed.name,
          url: deps.seed.playlistUrl,
          ...(deps.seed.guideUrl !== undefined ? { guideUrl: deps.seed.guideUrl } : {}),
        });

  if (!added.ok) {
    return { seeded: false };
  }

  await deps.secrets.set(DEV_SEEDED_KEY, '1');
  deps.onChanged?.();
  await deps.catalog.importSource(added.value.id);
  deps.onChanged?.();
  return { seeded: true, sourceId: added.value.id };
}
