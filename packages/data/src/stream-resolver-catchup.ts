import { elvError, err, type HttpClient, ok, type Result, type SqlDriver } from '@elv/domain';
import { buildCatchupUrl, normalizeCatchupMode, resolveXtreamBaseUrl } from '@elv/sources';
import { sourceOfKey } from './queries-shared';
import { getSource, type SourceRecord } from './sources';
import type { StalkerResolverState } from './stream-resolver-stalker';
import type {
  CatchupProgrammeInput,
  SourceStreamMeta,
  StreamRequest,
  StreamResolver,
  XtreamSecret,
} from './stream-resolver-types';

const notFound = () => err(elvError('storage', 'item-not-found'));
const XTREAM_LIVE_URL_RE =
  /^(https?:\/\/[^/?#]+)(?:\/live)?\/([^/?#]+)\/([^/?#]+)\/(\d+)(?:\.([a-z0-9]+))?(?:[?#].*)?$/i;

function decodeSafe(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** @internal Resolves a catch-up/archive playback stream for one live channel programme (`#220`). */
export async function resolveCatchupStreamInternal(
  itemKey: string,
  programme: CatchupProgrammeInput,
  nowMs: number | undefined,
  deps: {
    db: SqlDriver;
    http: HttpClient;
    resolverFor: (sourceId: string) => Promise<StreamResolver>;
    evictResolver: (sourceId: string) => void;
    xtreamSecretFor: (sourceId: string) => Promise<XtreamSecret | undefined>;
    stalkerState: StalkerResolverState;
    buildSourceStreamMeta: (source: SourceRecord) => SourceStreamMeta;
    effectiveXtreamTransport: (source: SourceRecord) => SourceRecord['settings']['transport'];
    isAllowedPlaybackUrl: (raw: string) => boolean;
    normalizeMulticastUrl: (url: string) => string;
    applyStoredHeadersJson: (
      headersJson: string | null,
      resolver: StreamResolver,
      headers: Record<string, string>,
    ) => boolean;
  },
): Promise<Result<StreamRequest>> {
  const sourceId = sourceOfKey(itemKey);
  if (sourceId === undefined) return notFound();
  const rows = await deps.db.all<{
    source_id: string;
    provider_id: string | null;
    catchup_days: number | null;
    catchup_mode: string | null;
    catchup_source_template: string | null;
    url_template: string | null;
    headers_json: string | null;
  }>(
    `SELECT source_id, provider_id, catchup_days, catchup_mode, catchup_source_template, url_template, headers_json
       FROM live
      WHERE source_id = ? AND key = ?
      LIMIT 1`,
    [sourceId, itemKey],
  );
  const row = rows[0];
  if (row === undefined) return notFound();
  const source = await getSource(deps.db, row.source_id);
  if (source === undefined) return notFound();
  const meta = deps.buildSourceStreamMeta(source);
  const { headers, accountKey, connectionMeta } = meta;
  const effectiveNow = nowMs !== undefined && Number.isFinite(nowMs) ? nowMs : Date.now();
  const tzOpt = source.settings.serverTimezone
    ? { serverTimezone: source.settings.serverTimezone }
    : {};

  if (source.kind === 'stalker') {
    return deps.stalkerState.resolveCatchup(
      source,
      itemKey,
      row.provider_id,
      row.catchup_days,
      programme,
      effectiveNow,
      meta,
      deps.isAllowedPlaybackUrl,
      deps.normalizeMulticastUrl,
    );
  }

  if (row.url_template === null) {
    const creds = await deps.xtreamSecretFor(row.source_id);
    if (creds === undefined) return err(elvError('storage', 'secret-missing'));
    const streamId = Number(row.provider_id);
    if (row.provider_id === null || !Number.isFinite(streamId)) return notFound();
    const ext = deps.effectiveXtreamTransport(source)?.xtreamFormat ?? 'ts';
    const server = resolveXtreamBaseUrl(creds.server, deps.http);
    const built = buildCatchupUrl({
      mode: 'xc',
      server,
      username: creds.username,
      password: creds.password,
      streamId,
      ext,
      ...tzOpt,
      programme,
      catchupDays: row.catchup_days,
      nowMs: effectiveNow,
    });
    if (!built.ok) return built;
    if (!deps.isAllowedPlaybackUrl(built.value)) {
      return err(elvError('playback', 'unsupported-scheme'));
    }
    return ok({
      url: deps.normalizeMulticastUrl(built.value.trim()),
      headers,
      accountKey,
      sourceId: row.source_id,
      channelKey: itemKey,
      ...connectionMeta,
    });
  }

  const resolver = await deps.resolverFor(row.source_id);
  const liveUrl = resolver.resolve(row.url_template);
  if (liveUrl === undefined) {
    deps.evictResolver(row.source_id);
    return err(elvError('storage', 'secret-missing'));
  }
  let catchupSource: string | undefined;
  if (row.catchup_source_template !== null) {
    const resolvedSource = resolver.resolve(row.catchup_source_template);
    if (resolvedSource === undefined) {
      deps.evictResolver(row.source_id);
      return err(elvError('storage', 'secret-missing'));
    }
    catchupSource = resolvedSource;
  }
  if (!deps.applyStoredHeadersJson(row.headers_json, resolver, headers)) {
    deps.evictResolver(row.source_id);
    return err(elvError('storage', 'secret-missing'));
  }
  const mode = normalizeCatchupMode(row.catchup_mode) ?? 'default';
  let built: Result<string>;
  if (mode === 'xc') {
    const match = XTREAM_LIVE_URL_RE.exec(liveUrl.trim());
    if (match !== null) {
      built = buildCatchupUrl({
        mode: 'xc',
        server: match[1] as string,
        username: decodeSafe(match[2] as string),
        password: decodeSafe(match[3] as string),
        streamId: match[4] as string,
        ...(match[5] !== undefined ? { ext: match[5] } : {}),
        ...tzOpt,
        programme,
        catchupDays: row.catchup_days,
        nowMs: effectiveNow,
      });
    } else {
      built = buildCatchupUrl({
        mode: 'default',
        liveUrl,
        ...(catchupSource !== undefined ? { catchupSource } : {}),
        ...tzOpt,
        programme,
        catchupDays: row.catchup_days,
        nowMs: effectiveNow,
      });
    }
  } else {
    built = buildCatchupUrl({
      mode,
      liveUrl,
      ...(catchupSource !== undefined ? { catchupSource } : {}),
      ...tzOpt,
      programme,
      catchupDays: row.catchup_days,
      nowMs: effectiveNow,
    });
  }
  if (!built.ok) return built;
  if (!deps.isAllowedPlaybackUrl(built.value)) {
    return err(elvError('playback', 'unsupported-scheme'));
  }
  return ok({
    url: deps.normalizeMulticastUrl(built.value.trim()),
    headers,
    accountKey,
    sourceId: row.source_id,
    channelKey: itemKey,
    ...connectionMeta,
  });
}
