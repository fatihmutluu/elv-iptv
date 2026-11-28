import {
  type ContentKind,
  elvError,
  err,
  type HttpClient,
  hostnameOf,
  normalizeMacAddress,
  ok,
  type Result,
  type SecretStore,
} from '@elv/domain';
import {
  createStalkerClient,
  normalizeStalkerPortalUrl,
  type StalkerClient,
  type StalkerClientOptions,
  type StalkerDiscoveredPortal,
  type StalkerLinkKind,
  type StalkerPortalMode,
} from '@elv/sources';
import { sha256Hex } from './credential-fingerprint';
import { isSecretKeyRotatedError } from './secret-errors';
import { type SourceRecord, secretKey } from './sources';

export {
  deleteStalkerCmdMap,
  encodeEpisodeMeta,
  encodeVodSeriesMeta,
  loadStalkerCmdMap,
  mergeStalkerCmdMap,
  parseEpisodeMeta,
  parseVodSeriesMeta,
  type StalkerCmdMap,
  type StalkerEpisodeMeta,
  saveStalkerCmdMap,
  stalkerEpisodeMetaKey,
  stalkerStaticFlagKey,
  stalkerVodSeriesMetaKey,
} from './stalker-cmds-store';

/** @internal Parsed Stalker portal credentials and optional discovered endpoint/mode stored strictly in `SecretStore`. */
export interface StalkerSecret {
  readonly portalUrl: string;
  readonly mac: string;
  readonly serialNumber?: string;
  readonly discoveredEndpoint?: string;
  readonly portalMode?: StalkerPortalMode;
  readonly deviceId?: string;
  readonly deviceId2?: string;
  readonly signature?: string;
  readonly login?: string;
  readonly password?: string;
}

const UNSAFE_IMAGE_TOKEN_RE = /(?:^|[?&;])(?:mac|token|auth|password|pass|pwd)=/i;

function optionalNonEmpty(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
}

/** Stable catalog key for a Stalker/Ministra item (`s:<sourceId>:<kind>:<providerId>`). */
export function stalkerKey(sourceId: string, kind: ContentKind, providerId: string): string {
  return `s:${sourceId}:${kind}:${providerId}`;
}

/** Lookup key inside `source.<id>.stalker_cmds`. */
export function stalkerCmdKey(kind: StalkerLinkKind, providerId: string): string {
  return `${kind}:${providerId}`;
}

/** Ensures a Stalker `provider_id` stored in SQLite never carries a raw URL or credentials. */
export function safeStalkerProviderId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.includes('://') || /[\r\n]/.test(trimmed)) {
    return `id_${sha256Hex(trimmed).slice(0, 16)}`;
  }
  return trimmed;
}

/** Strips image URLs that leak the portal host, MAC address, or credential query parameters. */
export function sanitizeStalkerImageUrl(
  raw: string | undefined,
  portalHost: string | undefined,
  mac: string,
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || !/^https?:\/\//i.test(trimmed)) return undefined;
  if (portalHost !== undefined && hostnameOf(trimmed) === portalHost) return undefined;
  if (UNSAFE_IMAGE_TOKEN_RE.test(trimmed)) return undefined;
  const lower = trimmed.toLowerCase();
  const macLower = mac.toLowerCase();
  if (
    lower.includes(macLower) ||
    lower.includes(macLower.replace(/:/g, '-')) ||
    lower.includes(macLower.replace(/:/g, '')) ||
    lower.includes(encodeURIComponent(macLower))
  ) {
    return undefined;
  }
  return trimmed;
}

/** Loads Stalker portal credentials from `SecretStore`; returns `undefined` if missing or malformed. */
export async function loadStalkerSecret(
  secrets: SecretStore,
  sourceId: string,
): Promise<StalkerSecret | undefined> {
  let raw: string | undefined;
  try {
    raw = await secrets.get(secretKey(sourceId, 'stalker'));
  } catch (error) {
    if (isSecretKeyRotatedError(error)) throw error;
    return undefined;
  }
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.portalUrl !== 'string' || typeof parsed.mac !== 'string') return undefined;
    const macRes = normalizeMacAddress(parsed.mac);
    const portalRes = normalizeStalkerPortalUrl(parsed.portalUrl);
    if (!macRes.ok || !portalRes.ok) return undefined;
    const sn = optionalNonEmpty(parsed.serialNumber);
    const rawDiscovered = optionalNonEmpty(parsed.discoveredEndpoint);
    const discoveredEndpoint =
      rawDiscovered !== undefined && normalizeStalkerPortalUrl(rawDiscovered).ok
        ? rawDiscovered
        : undefined;
    const portalMode: StalkerPortalMode | undefined =
      parsed.portalMode === 'simple' || parsed.portalMode === 'full'
        ? parsed.portalMode
        : undefined;
    const deviceId = optionalNonEmpty(parsed.deviceId);
    const deviceId2 = optionalNonEmpty(parsed.deviceId2);
    const signature = optionalNonEmpty(parsed.signature);
    const login = optionalNonEmpty(parsed.login);
    const password =
      typeof parsed.password === 'string' && parsed.password !== '' ? parsed.password : undefined;
    return {
      portalUrl: parsed.portalUrl.trim(),
      mac: macRes.value,
      ...(sn === undefined ? {} : { serialNumber: sn }),
      ...(discoveredEndpoint === undefined ? {} : { discoveredEndpoint }),
      ...(portalMode === undefined ? {} : { portalMode }),
      ...(deviceId === undefined ? {} : { deviceId }),
      ...(deviceId2 === undefined ? {} : { deviceId2 }),
      ...(signature === undefined ? {} : { signature }),
      ...(login === undefined ? {} : { login }),
      ...(password === undefined ? {} : { password }),
    };
  } catch {
    return undefined;
  }
}

/**
 * Best-effort persists discovered `endpoint` and `portalMode` back to `source.<id>.stalker` in
 * `SecretStore` without altering user credentials or resurrecting deleted sources.
 */
export async function saveStalkerDiscovery(
  secrets: SecretStore,
  sourceId: string,
  current: StalkerSecret,
  discovered: StalkerDiscoveredPortal | undefined,
): Promise<StalkerSecret> {
  if (discovered === undefined) return current;
  if (
    current.discoveredEndpoint === discovered.endpoint &&
    current.portalMode === discovered.mode
  ) {
    return current;
  }
  const key = secretKey(sourceId, 'stalker');
  try {
    const existingRaw = await secrets.get(key);
    if (existingRaw === undefined) return current;
    const updated: StalkerSecret = {
      ...current,
      discoveredEndpoint: discovered.endpoint,
      portalMode: discovered.mode,
    };
    await secrets.set(key, JSON.stringify(updated));
    return updated;
  } catch {
    return current;
  }
}

/** Extracts the normalized primary hostname of a Stalker portal URL, if valid. */
export function stalkerPortalHost(portalUrl: string): string | undefined {
  const normalized = normalizeStalkerPortalUrl(portalUrl);
  return normalized.ok ? hostnameOf(normalized.value.endpoint) : undefined;
}

/** Builds a credential-isolated {@link StalkerClient} for `source` from `SecretStore`. */
export async function openStalkerClient(
  source: SourceRecord,
  deps: { secrets: SecretStore; http: HttpClient; maxBodyBytes?: number },
): Promise<Result<{ client: StalkerClient; secret: StalkerSecret }>> {
  let secret: StalkerSecret | undefined;
  try {
    secret = await loadStalkerSecret(deps.secrets, source.id);
  } catch (error) {
    if (isSecretKeyRotatedError(error)) return err(elvError('storage', 'secret-key-rotated'));
    throw error;
  }
  if (secret === undefined) return err(elvError('storage', 'secret-missing'));
  const options: StalkerClientOptions = {
    http: deps.http,
    portalUrl: secret.portalUrl,
    mac: secret.mac,
    ...(secret.serialNumber !== undefined ? { serialNumber: secret.serialNumber } : {}),
    ...(secret.discoveredEndpoint !== undefined
      ? { discoveredEndpoint: secret.discoveredEndpoint }
      : {}),
    ...(secret.portalMode !== undefined ? { portalMode: secret.portalMode } : {}),
    ...(secret.deviceId !== undefined ? { deviceId: secret.deviceId } : {}),
    ...(secret.deviceId2 !== undefined ? { deviceId2: secret.deviceId2 } : {}),
    ...(secret.signature !== undefined ? { signature: secret.signature } : {}),
    ...(secret.login !== undefined ? { login: secret.login } : {}),
    ...(secret.password !== undefined ? { password: secret.password } : {}),
    ...(source.settings.serverTimezone ? { timezone: source.settings.serverTimezone } : {}),
    ...(source.settings.transport !== undefined ? { transport: source.settings.transport } : {}),
    ...(deps.maxBodyBytes !== undefined ? { maxBodyBytes: deps.maxBodyBytes } : {}),
  };
  return ok({ client: createStalkerClient(options), secret });
}
