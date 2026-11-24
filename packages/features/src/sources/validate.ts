import {
  type AddSourceInput,
  type LinkSourceInput,
  type LocalM3uSourceInput,
  parseXtreamLink,
} from '@elv/data';
import {
  type DnsFamilyPreference,
  err,
  normalizeDnsFamily,
  normalizeMacAddress,
  ok,
  type Result,
  type TransportSettings,
  validateHostOverride,
} from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import type { PickedPlaylistFile } from '../ports/source-import-host';

/** Controlled state of the add-source form across Xtream, M3U, and Stalker modes. */
export interface SourceFormState {
  mode: 'xtream' | 'm3u' | 'stalker';
  name: string;
  server: string;
  username: string;
  password: string;
  xtreamFormat: 'default' | 'ts' | 'm3u8';
  playlistUrl: string;
  keepAsM3u: boolean;
  /** Stalker / Ministra portal URL (`#29`). */
  portalUrl: string;
  /** Stalker / Ministra device MAC address (`#29`). */
  macAddress: string;
  /** Optional Stalker / Ministra device serial number (`#29`). */
  serialNumber: string;
  guideUrl: string;
  userAgent: string;
  referer: string;
  /** Optional local playlist file selected via platform picker (`#51`). */
  localFile?: PickedPlaylistFile | null;
  /** Optional IANA timezone for offset-less XMLTV timestamps (`#182`). */
  xmltvTimezone?: string;
  /** Opt-in legacy TLS (TLS 1.0/1.1) compatibility for older endpoints (`#182`). */
  allowLegacyTls?: boolean;
  /** Optional per-source DNS IP family preference (`#172`). */
  dnsFamily?: DnsFamilyPreference;
  /** Optional literal IPv4/IPv6 host override scoped to the source origin (`#172`). */
  hostOverride?: string;
  /** Optional newline-separated backup server URLs for Xtream mode (`#317`). */
  backupServers?: string;
}

/** Pre-import validation failure codes. */
export type SourceValidationCode =
  | 'missing-server'
  | 'missing-credentials'
  | 'missing-url'
  | 'missing-scheme'
  | 'unsupported-scheme'
  | 'invalid-address'
  | 'invalid-mac'
  | 'invalid-guide-url'
  | 'invalid-timezone'
  | 'invalid-host-override'
  | 'invalid-characters'
  | 'm3u-in-xtream';

/** Localized validation failure paired with an actionable hint. */
export interface SourceValidationError {
  readonly code: SourceValidationCode;
  readonly messageId: MessageId;
  readonly hintId: MessageId;
}

/** Normalized submission payload ready for `CatalogService.addSource`, `addSourceFromLink`, or `addLocalM3uSource`. */
export type ValidatedSourceSubmission =
  | { readonly kind: 'xtream'; readonly input: AddSourceInput & { kind: 'xtream' } }
  | { readonly kind: 'stalker'; readonly input: AddSourceInput & { kind: 'stalker' } }
  | {
      readonly kind: 'link';
      readonly input: LinkSourceInput;
      readonly detectedXtream: boolean;
      readonly xmltvTimezone?: string;
    }
  | { readonly kind: 'local-m3u'; readonly input: LocalM3uSourceInput };

const VALIDATION_MESSAGES: Readonly<
  Record<SourceValidationCode, { messageId: MessageId; hintId: MessageId }>
> = {
  'missing-server': {
    messageId: 'source.validation.missingServer',
    hintId: 'source.hint.missingServer',
  },
  'missing-credentials': {
    messageId: 'source.validation.missingCredentials',
    hintId: 'source.hint.missingCredentials',
  },
  'missing-url': {
    messageId: 'source.validation.missingUrl',
    hintId: 'source.hint.missingUrl',
  },
  'missing-scheme': {
    messageId: 'source.validation.missingScheme',
    hintId: 'source.hint.missingScheme',
  },
  'unsupported-scheme': {
    messageId: 'source.validation.unsupportedScheme',
    hintId: 'source.hint.unsupportedScheme',
  },
  'invalid-address': {
    messageId: 'source.validation.invalidAddress',
    hintId: 'source.hint.invalidAddress',
  },
  'invalid-mac': {
    messageId: 'sources.stalker.invalidMac',
    hintId: 'sources.stalker.invalidMacHint',
  },
  'invalid-guide-url': {
    messageId: 'source.validation.invalidGuideUrl',
    hintId: 'source.hint.invalidGuideUrl',
  },
  'invalid-timezone': {
    messageId: 'sources.xmltvTimezoneLabel',
    hintId: 'sources.xmltvTimezoneHint',
  },
  'invalid-host-override': {
    messageId: 'sources.network.invalidHostOverride',
    hintId: 'sources.network.hostOverrideHint',
  },
  'invalid-characters': {
    messageId: 'source.validation.invalidCharacters',
    hintId: 'source.hint.invalidCharacters',
  },
  'm3u-in-xtream': {
    messageId: 'source.validation.m3uInXtream',
    hintId: 'source.hint.m3uInXtream',
  },
};

function fail(code: SourceValidationCode): Result<never, SourceValidationError> {
  const { messageId, hintId } = VALIDATION_MESSAGES[code];
  return err({ code, messageId, hintId });
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const OTHER_URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d+(?:[/?#]|$))/;

function extractExplicitPort(authority: string): string | null | 'malformed' {
  const atIdx = authority.lastIndexOf('@');
  const hostPort = atIdx >= 0 ? authority.slice(atIdx + 1) : authority;
  if (hostPort === '') return 'malformed';
  if (hostPort.startsWith('[')) {
    const closeIdx = hostPort.indexOf(']');
    if (closeIdx < 0) return 'malformed';
    const rest = hostPort.slice(closeIdx + 1);
    if (rest === '') return null;
    if (!rest.startsWith(':')) return 'malformed';
    return rest.slice(1);
  }
  const firstColon = hostPort.indexOf(':');
  if (firstColon < 0) return null;
  if (hostPort.indexOf(':', firstColon + 1) >= 0) return 'malformed';
  return hostPort.slice(firstColon + 1);
}

function validateHttpUrl(trimmed: string): Result<URL, SourceValidationError> {
  if (!trimmed.includes('://')) {
    if (OTHER_URI_SCHEME.test(trimmed)) return fail('unsupported-scheme');
    return fail('missing-scheme');
  }
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/s.exec(trimmed);
  if (schemeMatch === null) return fail('invalid-address');
  const scheme = (schemeMatch[1] ?? '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return fail('unsupported-scheme');
  const remainder = schemeMatch[2] ?? '';
  const authorityEnd = remainder.search(/[/?#]/);
  const authority = authorityEnd >= 0 ? remainder.slice(0, authorityEnd) : remainder;
  const explicitPort = extractExplicitPort(authority);
  if (explicitPort === 'malformed') return fail('invalid-address');
  if (explicitPort !== null) {
    if (!/^\d+$/.test(explicitPort)) return fail('invalid-address');
    const portNum = Number(explicitPort);
    if (portNum < 1 || portNum > 65535) return fail('invalid-address');
  }
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) return fail('invalid-address');
    return ok(parsed);
  } catch {
    return fail('invalid-address');
  }
}

function normalizeServerBase(serverUrl: string): string {
  return serverUrl
    .replace(/[?#].*$/s, '')
    .replace(/\/+$/, '')
    .replace(/\/(?:player_api|get|xmltv)\.php$/i, '')
    .replace(/\/+$/, '');
}

function buildTransport(
  userAgent: string,
  referer: string,
  xtreamFormat: 'ts' | 'm3u8' | undefined,
  allowLegacyTls: boolean,
  dnsFamily: DnsFamilyPreference | undefined,
  hostOverride: string | undefined,
): TransportSettings | undefined {
  const transport: TransportSettings = {
    ...(userAgent !== '' ? { userAgent } : {}),
    ...(referer !== '' ? { referer } : {}),
    ...(xtreamFormat !== undefined ? { xtreamFormat } : {}),
    ...(allowLegacyTls ? { allowLegacyTls: true } : {}),
    ...(dnsFamily !== undefined ? { dnsFamily } : {}),
    ...(hostOverride !== undefined ? { hostOverride } : {}),
  };
  return Object.keys(transport).length > 0 ? transport : undefined;
}

function parseBackupServers(
  raw: string | undefined,
): Result<readonly string[] | undefined, SourceValidationError> {
  if (raw === undefined || raw.trim() === '') return ok(undefined);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (hasControlChars(line)) return fail('invalid-characters');
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const checked = validateHttpUrl(trimmed);
    if (!checked.ok) return checked;
    const base = normalizeServerBase(trimmed);
    if (!seen.has(base)) {
      seen.add(base);
      normalized.push(base);
    }
  }
  return ok(normalized.length > 0 ? normalized : undefined);
}

/** Validates whether `tz` is a recognized IANA timezone identifier via `Intl.DateTimeFormat` (`#182`). */
export function isValidIanaTimeZone(tz: string): boolean {
  const trimmed = tz.trim();
  if (trimmed === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/** Creates a blank initial form state defaulting to Xtream mode. */
export function createInitialSourceForm(): SourceFormState {
  return {
    mode: 'xtream',
    name: '',
    server: '',
    username: '',
    password: '',
    xtreamFormat: 'default',
    playlistUrl: '',
    keepAsM3u: false,
    portalUrl: '',
    macAddress: '',
    serialNumber: '',
    guideUrl: '',
    userAgent: '',
    referer: '',
    localFile: null,
    xmltvTimezone: '',
    allowLegacyTls: false,
    dnsFamily: 'system',
    hostOverride: '',
    backupServers: '',
  };
}

/** Returns `true` when `url` is a clean pasted Xtream `get.php?username=…&password=…` link. */
export function detectPastedXtreamLink(url: string): boolean {
  if (hasControlChars(url)) return false;
  return parseXtreamLink(url.trim()) !== undefined;
}

/** Validates user-entered source form fields before touching the network or secret store. */
export function validateSourceForm(
  form: SourceFormState,
  opts?: { readonly defaultLocalPlaylistName?: string },
): Result<ValidatedSourceSubmission, SourceValidationError> {
  const xmltvTimezoneRaw = (form.xmltvTimezone ?? '').trim();
  const allowLegacyTls = form.allowLegacyTls === true;
  const localFile = form.localFile ?? null;
  const fields = [
    form.name,
    form.server,
    form.username,
    form.password,
    form.playlistUrl,
    form.portalUrl,
    form.macAddress,
    form.serialNumber,
    form.guideUrl,
    form.userAgent,
    form.referer,
    form.xmltvTimezone ?? '',
    form.hostOverride ?? '',
  ];
  if (fields.some(hasControlChars)) {
    return fail('invalid-characters');
  }

  if (xmltvTimezoneRaw !== '' && !isValidIanaTimeZone(xmltvTimezoneRaw)) {
    return fail('invalid-timezone');
  }

  const hostOverrideChecked = validateHostOverride(form.hostOverride);
  if (!hostOverrideChecked.ok) {
    return fail('invalid-host-override');
  }
  const hostOverride = hostOverrideChecked.value;
  const normalizedDns = normalizeDnsFamily(form.dnsFamily);
  const dnsFamily =
    normalizedDns !== undefined && normalizedDns !== 'system' ? normalizedDns : undefined;

  const guideRaw = form.guideUrl.trim();
  if (guideRaw !== '') {
    const guideChecked = validateHttpUrl(guideRaw);
    if (!guideChecked.ok) return fail('invalid-guide-url');
  }

  const refererRaw = form.referer.trim();
  if (refererRaw !== '') {
    const refererChecked = validateHttpUrl(refererRaw);
    if (!refererChecked.ok) return refererChecked;
  }

  const userAgent = form.userAgent.trim();
  const explicitFormat = form.xtreamFormat === 'default' ? undefined : form.xtreamFormat;

  if (form.mode === 'xtream') {
    const serverRaw = form.server.trim();
    if (serverRaw === '') return fail('missing-server');
    const parsedServer = validateHttpUrl(serverRaw);
    if (!parsedServer.ok) return parsedServer;

    const backupChecked = parseBackupServers(form.backupServers);
    if (!backupChecked.ok) return backupChecked;
    const backupServers = backupChecked.value;

    const pasted = parseXtreamLink(serverRaw);
    if (pasted !== undefined) {
      const username = form.username.trim() || pasted.username;
      const password = form.password.trim() || pasted.password;
      const format = explicitFormat ?? pasted.output;
      const transport = buildTransport(
        userAgent,
        refererRaw,
        format,
        allowLegacyTls,
        dnsFamily,
        hostOverride,
      );
      const name = form.name.trim() || new URL(pasted.server).host;
      return ok({
        kind: 'xtream',
        input: {
          kind: 'xtream',
          name,
          server: pasted.server,
          username,
          password,
          ...(backupServers !== undefined ? { backupServers } : {}),
          ...(guideRaw !== '' ? { guideUrl: guideRaw } : {}),
          ...(transport !== undefined ? { transport } : {}),
          ...(xmltvTimezoneRaw !== '' ? { xmltvTimezone: xmltvTimezoneRaw } : {}),
        },
      });
    }

    if (/\.m3u8?$/i.test(parsedServer.value.pathname)) {
      return fail('m3u-in-xtream');
    }

    const username = form.username.trim();
    const password = form.password.trim();
    if (username === '' || password === '') {
      return fail('missing-credentials');
    }

    const normalizedServer = normalizeServerBase(serverRaw);
    const name = form.name.trim() || new URL(normalizedServer).host;
    const transport = buildTransport(
      userAgent,
      refererRaw,
      explicitFormat,
      allowLegacyTls,
      dnsFamily,
      hostOverride,
    );
    return ok({
      kind: 'xtream',
      input: {
        kind: 'xtream',
        name,
        server: normalizedServer,
        username,
        password,
        ...(backupServers !== undefined ? { backupServers } : {}),
        ...(guideRaw !== '' ? { guideUrl: guideRaw } : {}),
        ...(transport !== undefined ? { transport } : {}),
        ...(xmltvTimezoneRaw !== '' ? { xmltvTimezone: xmltvTimezoneRaw } : {}),
      },
    });
  }

  if (form.mode === 'stalker') {
    const portalRaw = form.portalUrl.trim();
    if (portalRaw === '') return fail('missing-server');
    let candidatePortal = portalRaw;
    if (!portalRaw.includes('://')) {
      if (OTHER_URI_SCHEME.test(portalRaw)) return fail('unsupported-scheme');
      candidatePortal = `http://${portalRaw}`;
    }
    const parsedPortal = validateHttpUrl(candidatePortal);
    if (!parsedPortal.ok) return parsedPortal;
    if (parsedPortal.value.username !== '' || parsedPortal.value.password !== '') {
      return fail('invalid-address');
    }

    const macRes = normalizeMacAddress(form.macAddress);
    if (!macRes.ok) return fail('invalid-mac');

    const serialNumber = form.serialNumber.trim();
    if (serialNumber.length > 128) return fail('invalid-characters');
    const name = form.name.trim() || parsedPortal.value.host;
    const transport = buildTransport(
      userAgent,
      refererRaw,
      undefined,
      allowLegacyTls,
      dnsFamily,
      hostOverride,
    );
    return ok({
      kind: 'stalker',
      input: {
        kind: 'stalker',
        name,
        portalUrl: candidatePortal,
        mac: macRes.value,
        ...(serialNumber !== '' ? { serialNumber } : {}),
        ...(guideRaw !== '' ? { guideUrl: guideRaw } : {}),
        ...(transport !== undefined ? { transport } : {}),
        ...(xmltvTimezoneRaw !== '' ? { xmltvTimezone: xmltvTimezoneRaw } : {}),
      },
    });
  }

  if (localFile !== null && localFile.bytes.byteLength > 0) {
    const strippedFileName = localFile.name.replace(/\.(?:m3u8?|gz)$/i, '').trim();
    const fallbackName = opts?.defaultLocalPlaylistName?.trim() || 'M3U';
    const name = form.name.trim() || strippedFileName || fallbackName;
    const transport = buildTransport(
      userAgent,
      refererRaw,
      explicitFormat,
      allowLegacyTls,
      dnsFamily,
      hostOverride,
    );
    return ok({
      kind: 'local-m3u',
      input: {
        name,
        bytes: localFile.bytes,
        ...(guideRaw !== '' ? { guideUrl: guideRaw } : {}),
        ...(transport !== undefined ? { transport } : {}),
        ...(xmltvTimezoneRaw !== '' ? { xmltvTimezone: xmltvTimezoneRaw } : {}),
      },
    });
  }

  const urlRaw = form.playlistUrl.trim();
  if (urlRaw === '') return fail('missing-url');
  const parsedPlaylist = validateHttpUrl(urlRaw);
  if (!parsedPlaylist.ok) return parsedPlaylist;

  const detectedXtream = !form.keepAsM3u && parseXtreamLink(urlRaw) !== undefined;
  const name = form.name.trim() || parsedPlaylist.value.host;
  const transport = buildTransport(
    userAgent,
    refererRaw,
    explicitFormat,
    allowLegacyTls,
    dnsFamily,
    hostOverride,
  );
  return ok({
    kind: 'link',
    detectedXtream,
    ...(xmltvTimezoneRaw !== '' ? { xmltvTimezone: xmltvTimezoneRaw } : {}),
    input: {
      name,
      url: urlRaw,
      ...(form.keepAsM3u ? { keepAsM3u: true } : {}),
      ...(guideRaw !== '' ? { guideUrl: guideRaw } : {}),
      ...(transport !== undefined ? { transport } : {}),
    },
  });
}
