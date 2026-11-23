import {
  type AddSourceInput,
  type LinkSourceInput,
  type LocalM3uSourceInput,
  parseXtreamLink,
} from '@elv/data';
import { err, ok, type Result, type TransportSettings } from '@elv/domain';
import type { MessageId } from '@elv/i18n';
import type { PickedPlaylistFile } from '../ports/source-import-host';

/** Controlled state of the add-source form across Xtream and M3U modes. */
export interface SourceFormState {
  mode: 'xtream' | 'm3u';
  name: string;
  server: string;
  username: string;
  password: string;
  xtreamFormat: 'default' | 'ts' | 'm3u8';
  playlistUrl: string;
  keepAsM3u: boolean;
  guideUrl: string;
  userAgent: string;
  referer: string;
  /** Optional local playlist file selected via platform picker (`#51`). */
  localFile?: PickedPlaylistFile | null;
  /** Optional IANA timezone for offset-less XMLTV timestamps (`#182`). */
  xmltvTimezone?: string;
  /** Opt-in legacy TLS (TLS 1.0/1.1) compatibility for older endpoints (`#182`). */
  allowLegacyTls?: boolean;
}

/** Pre-import validation failure codes. */
export type SourceValidationCode =
  | 'missing-server'
  | 'missing-credentials'
  | 'missing-url'
  | 'missing-scheme'
  | 'unsupported-scheme'
  | 'invalid-address'
  | 'invalid-guide-url'
  | 'invalid-timezone'
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
  'invalid-guide-url': {
    messageId: 'source.validation.invalidGuideUrl',
    hintId: 'source.hint.invalidGuideUrl',
  },
  'invalid-timezone': {
    messageId: 'sources.xmltvTimezoneLabel',
    hintId: 'sources.xmltvTimezoneHint',
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
): TransportSettings | undefined {
  const transport: TransportSettings = {
    ...(userAgent !== '' ? { userAgent } : {}),
    ...(referer !== '' ? { referer } : {}),
    ...(xtreamFormat !== undefined ? { xtreamFormat } : {}),
    ...(allowLegacyTls ? { allowLegacyTls: true } : {}),
  };
  return Object.keys(transport).length > 0 ? transport : undefined;
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
    guideUrl: '',
    userAgent: '',
    referer: '',
    localFile: null,
    xmltvTimezone: '',
    allowLegacyTls: false,
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
    form.guideUrl,
    form.userAgent,
    form.referer,
    form.xmltvTimezone ?? '',
  ];
  if (fields.some(hasControlChars)) {
    return fail('invalid-characters');
  }

  if (xmltvTimezoneRaw !== '' && !isValidIanaTimeZone(xmltvTimezoneRaw)) {
    return fail('invalid-timezone');
  }

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

    const pasted = parseXtreamLink(serverRaw);
    if (pasted !== undefined) {
      const username = form.username.trim() || pasted.username;
      const password = form.password.trim() || pasted.password;
      const format = explicitFormat ?? pasted.output;
      const transport = buildTransport(userAgent, refererRaw, format, allowLegacyTls);
      const name = form.name.trim() || new URL(pasted.server).host;
      return ok({
        kind: 'xtream',
        input: {
          kind: 'xtream',
          name,
          server: pasted.server,
          username,
          password,
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
    const transport = buildTransport(userAgent, refererRaw, explicitFormat, allowLegacyTls);
    return ok({
      kind: 'xtream',
      input: {
        kind: 'xtream',
        name,
        server: normalizedServer,
        username,
        password,
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
    const transport = buildTransport(userAgent, refererRaw, explicitFormat, allowLegacyTls);
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
  const transport = buildTransport(userAgent, refererRaw, explicitFormat, allowLegacyTls);
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
