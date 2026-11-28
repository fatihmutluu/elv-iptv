import type { EngineError, MediaKind } from '@elv/playback';
import { redactUrls } from './redact.ts';

/** One mpv `log-message` event reduced to the fields the error mapping reads. */
export interface MpvLogLine {
  prefix: string;
  level: string;
  text: string;
}

/** What an `end-file` event means for the engine. */
export type EndOutcome =
  | { kind: 'ended' }
  | { kind: 'stopped' }
  | { kind: 'error'; error: EngineError };

const MAX_DETAIL = 200;
const HTTP_CODES: Readonly<Record<number, EngineError['code']>> = {
  401: 'http-401',
  403: 'http-403',
  404: 'http-404',
  407: 'http-401',
  410: 'http-404',
  429: 'http-429',
  451: 'http-404',
  458: 'connection-limit',
  460: 'connection-limit',
  461: 'connection-limit',
  462: 'connection-limit',
  463: 'connection-limit',
  469: 'connection-limit',
  509: 'http-509',
};

const NETWORK_PATTERN =
  /Connection (refused|reset)|failed: Error number|timed out|Connection to .* failed|\b(tls|ssl)\b.*(error|fail|alert|verify|certificate|handshake)|certificate (verif|expired|revoked|invalid|untrusted)|self[- ]signed certificate|handshake failed|schannel:.*failed|SEC_E_/i;

const DECODER_PATTERN =
  /no audio or video data played|Could not open codec|Failed to initialize a decoder|Error initializing|decoder init failed|VO: .*(failed|error)/i;

function error(e: EngineError): EndOutcome {
  return {
    kind: 'error',
    error: e.detail === undefined ? e : { ...e, detail: redactUrls(e.detail).slice(0, MAX_DETAIL) },
  };
}

function withDetail(code: EngineError['code'], detail: string, httpStatus?: number): EndOutcome {
  return error({ code, detail, ...(httpStatus === undefined ? {} : { httpStatus }) });
}

function lastHttpLine(logs: readonly MpvLogLine[]): { status: number; text: string } | undefined {
  for (const line of [...logs].reverse()) {
    const status = /HTTP error ([0-9]{3})/.exec(line.text)?.[1];
    if (status !== undefined) return { status: Number(status), text: line.text };
  }
  return undefined;
}

const findLine = (logs: readonly MpvLogLine[], pattern: RegExp): MpvLogLine | undefined =>
  logs.find((l) => pattern.test(l.text));

function classifyHttp(http: { status: number; text: string }): EndOutcome | undefined {
  const code = HTTP_CODES[http.status];
  if (code) return withDetail(code, http.text, http.status);
  if (http.status >= 400 && http.status < 600) {
    return withDetail('http-other', http.text, http.status);
  }
  return undefined;
}

function isPrematureVodEof(
  positionMs: number | undefined,
  durationMs: number | undefined,
): boolean {
  return (
    durationMs !== undefined &&
    Number.isFinite(durationMs) &&
    durationMs > 0 &&
    positionMs !== undefined &&
    Number.isFinite(positionMs) &&
    positionMs > 0 &&
    durationMs - positionMs > Math.max(10_000, durationMs * 0.01)
  );
}

/**
 * Maps an mpv `end-file` event and the media's recent log lines to an engine outcome.
 * A provider's plain-text notice (`Mime-type: 'text/*'` then an unrecognized format) is the
 * connection-limit signal, since providers answer over-limit requests with a text page.
 * `played: false` (playback never restarted) inspects HTTP, notice, network/TLS and decoder logs
 * before falling back to `empty-vod-eof` or `live-eof`. Omitted means played.
 * For played VOD `eof`, a premature stop well before `durationMs` inspects HTTP, network, and
 * decoder logs before falling back to `vod-premature-eof`.
 */
export function classifyEnd(p: {
  reason: string;
  fileError?: string;
  logs: readonly MpvLogLine[];
  mediaKind: MediaKind;
  played?: boolean;
  positionMs?: number;
  durationMs?: number;
}): EndOutcome {
  if (p.reason === 'stop' || p.reason === 'quit' || p.reason === 'redirect') {
    return { kind: 'stopped' };
  }
  if (p.reason === 'eof') {
    if (p.played !== false) {
      if (p.mediaKind !== 'vod') return error({ code: 'network', detail: 'live-eof' });
      if (isPrematureVodEof(p.positionMs, p.durationMs)) {
        const http = lastHttpLine(p.logs);
        const httpOutcome = http ? classifyHttp(http) : undefined;
        if (httpOutcome) return httpOutcome;
        const network = findLine(p.logs, NETWORK_PATTERN);
        if (network) return withDetail('network', network.text);
        const decoder = findLine(p.logs, DECODER_PATTERN);
        if (decoder) return withDetail('decoder', decoder.text);
        return error({ code: 'network', detail: 'vod-premature-eof' });
      }
      return { kind: 'ended' };
    }
    const http = lastHttpLine(p.logs);
    const httpOutcome = http ? classifyHttp(http) : undefined;
    if (httpOutcome) return httpOutcome;
    const notice = findLine(p.logs, /Mime-type: 'text\//);
    if (notice) return withDetail('connection-limit', notice.text);
    const network = findLine(p.logs, NETWORK_PATTERN);
    if (network) return withDetail('network', network.text);
    const decoder = findLine(p.logs, DECODER_PATTERN);
    if (decoder) return withDetail('decoder', decoder.text);
    return error({
      code: 'network',
      detail: p.mediaKind === 'vod' ? 'empty-vod-eof' : 'live-eof',
    });
  }
  const http = lastHttpLine(p.logs);
  const httpOutcome = http ? classifyHttp(http) : undefined;
  if (httpOutcome) return httpOutcome;
  const unrecognized =
    p.fileError === 'unrecognized file format' || findLine(p.logs, /unrecognized file format/i);
  if (unrecognized) {
    const notice = findLine(p.logs, /Mime-type: 'text\//);
    return notice
      ? withDetail('connection-limit', notice.text)
      : withDetail('unsupported-format', 'unrecognized file format');
  }
  const network = findLine(p.logs, NETWORK_PATTERN);
  if (network) return withDetail('network', network.text);
  const decoder = findLine(p.logs, DECODER_PATTERN);
  if (decoder) return withDetail('decoder', decoder.text);
  return withDetail('unknown', p.fileError ?? 'unknown');
}
