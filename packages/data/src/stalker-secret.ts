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
  type StalkerLinkKind,
} from '@elv/sources';
import { sha256Hex } from './credential-fingerprint';
import { type SourceRecord, secretKey } from './sources';

/** @internal Parsed Stalker portal credentials stored strictly in `SecretStore`. */
export interface StalkerSecret {
  readonly portalUrl: string;
  readonly mac: string;
  readonly serialNumber?: string;
}

/** @internal Opaque per-item Stalker `cmd` strings stored strictly in `SecretStore`. */
export type StalkerCmdMap = Record<string, string>;

const UNSAFE_IMAGE_TOKEN_RE = /(?:^|[?&;])(?:mac|token|auth|password|pass|pwd)=/i;

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
  const raw = await secrets.get(secretKey(sourceId, 'stalker')).catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      portalUrl?: unknown;
      mac?: unknown;
      serialNumber?: unknown;
    };
    if (typeof parsed.portalUrl !== 'string' || typeof parsed.mac !== 'string') return undefined;
    const macRes = normalizeMacAddress(parsed.mac);
    const portalRes = normalizeStalkerPortalUrl(parsed.portalUrl);
    if (!macRes.ok || !portalRes.ok) return undefined;
    const sn =
      typeof parsed.serialNumber === 'string' && parsed.serialNumber.trim() !== ''
        ? parsed.serialNumber.trim()
        : undefined;
    return {
      portalUrl: parsed.portalUrl.trim(),
      mac: macRes.value,
      ...(sn === undefined ? {} : { serialNumber: sn }),
    };
  } catch {
    return undefined;
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
  const secret = await loadStalkerSecret(deps.secrets, source.id);
  if (secret === undefined) return err(elvError('storage', 'secret-missing'));
  const options: StalkerClientOptions = {
    http: deps.http,
    portalUrl: secret.portalUrl,
    mac: secret.mac,
    ...(secret.serialNumber !== undefined ? { serialNumber: secret.serialNumber } : {}),
    ...(source.settings.serverTimezone ? { timezone: source.settings.serverTimezone } : {}),
    ...(source.settings.transport !== undefined ? { transport: source.settings.transport } : {}),
    ...(deps.maxBodyBytes !== undefined ? { maxBodyBytes: deps.maxBodyBytes } : {}),
  };
  return ok({ client: createStalkerClient(options), secret });
}

/** Loads the per-source Stalker play-time command map from `SecretStore`. */
export async function loadStalkerCmdMap(
  secrets: SecretStore,
  sourceId: string,
): Promise<StalkerCmdMap> {
  const raw = await secrets.get(secretKey(sourceId, 'stalker_cmds')).catch(() => undefined);
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: StalkerCmdMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persists the per-source Stalker play-time command map into `SecretStore`. */
export async function saveStalkerCmdMap(
  secrets: SecretStore,
  sourceId: string,
  map: StalkerCmdMap,
): Promise<Result<void>> {
  try {
    await secrets.set(secretKey(sourceId, 'stalker_cmds'), JSON.stringify(map));
    return ok(undefined);
  } catch {
    return err(elvError('storage', 'secret-store-failed'));
  }
}

/** Merges additional Stalker command entries into `source.<id>.stalker_cmds` inside `SecretStore`. */
export async function mergeStalkerCmdMap(
  secrets: SecretStore,
  sourceId: string,
  additions: StalkerCmdMap,
): Promise<Result<void>> {
  if (Object.keys(additions).length === 0) return ok(undefined);
  const existing = await loadStalkerCmdMap(secrets, sourceId);
  return saveStalkerCmdMap(secrets, sourceId, { ...existing, ...additions });
}
