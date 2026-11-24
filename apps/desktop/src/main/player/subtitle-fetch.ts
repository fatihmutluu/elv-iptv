import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type ExternalSubtitleTrack,
  inferSubtitleMimeType,
  MAX_EXTERNAL_SUBTITLE_URI_LENGTH,
  sanitizeExternalSubtitleHeaders,
} from '@elv/playback';

/** Allowed local and external subtitle file extensions (`#32`, `#308`). */
export const ALLOWED_SUBTITLE_EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa', 'ttml', 'sub'] as const;

const ALLOWED_EXTENSION_SET: ReadonlySet<string> = new Set(ALLOWED_SUBTITLE_EXTENSIONS);
const DEFAULT_MAX_FETCH_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_LOCAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_STRIPPED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
]);

interface SubtitleHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: AsyncIterable<Uint8Array> | Uint8Array;
  destroy?(): void;
}

type SubtitleHttpClient = (
  url: string,
  options: {
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
) => Promise<SubtitleHttpResponse>;

interface SubtitleFetchSessionOptions {
  readonly http?: SubtitleHttpClient;
  readonly maxBytes?: number;
  readonly maxLocalBytes?: number;
  readonly tempRoot?: string;
  readonly timeoutMs?: number;
}

/** Per-engine external subtitle fetch & local validation session with synchronous temp cleanup (`#308`). */
export interface SubtitleFetchSession {
  resolveTrack(track: ExternalSubtitleTrack, signal?: AbortSignal): Promise<string>;
  cleanup(): void;
}

interface SubtitleOpenDialogOptions {
  readonly properties: readonly 'openFile'[];
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[];
}

interface SubtitleOpenDialogResult {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

interface SubtitleFilePickerDeps<TWindow = unknown> {
  getWindowFromSender(sender: unknown): TWindow | null | undefined;
  showOpenDialog(
    window: TWindow | null | undefined,
    options: SubtitleOpenDialogOptions,
  ): Promise<SubtitleOpenDialogResult>;
  maxLocalBytes?: number;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function stripCrossOriginSensitiveHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (CROSS_ORIGIN_STRIPPED_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

function firstHeader(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  target: string,
): string | undefined {
  const lower = target.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (typeof val === 'string') return val;
    if (Array.isArray(val) && typeof val[0] === 'string') return val[0];
  }
  return undefined;
}

function defaultIsolatedHttpClient(
  url: string,
  options: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal },
): Promise<SubtitleHttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error('Unsupported subtitle HTTP scheme'));
      return;
    }
    const requester = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requester(
      parsed,
      {
        method: 'GET',
        agent: false,
        headers: { ...options.headers },
        signal: options.signal,
      },
      (res: IncomingMessage) => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers as Readonly<Record<string, string | readonly string[] | undefined>>,
          body: res,
          destroy: () => res.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function inferTempExtension(uri: string, explicitMime?: string): string {
  try {
    const parsed = new URL(uri);
    const ext = extname(parsed.pathname).slice(1).toLowerCase();
    if (ALLOWED_EXTENSION_SET.has(ext)) return ext;
  } catch {
    // Fall back to MIME mapping below.
  }
  const mime = inferSubtitleMimeType(uri, explicitMime);
  if (mime === 'text/vtt') return 'vtt';
  if (mime === 'text/x-ssa') return 'ass';
  if (mime === 'application/ttml+xml') return 'ttml';
  return 'srt';
}

async function readBoundedBody(
  body: AsyncIterable<Uint8Array> | Uint8Array,
  maxBytes: number,
  signal: AbortSignal,
  destroy?: () => void,
): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) {
      throw new Error(`External subtitle exceeds ${maxBytes} byte size limit`);
    }
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    if (signal.aborted) {
      destroy?.();
      throw new Error('External subtitle fetch aborted');
    }
    total += chunk.byteLength;
    if (total > maxBytes) {
      destroy?.();
      throw new Error(`External subtitle exceeds ${maxBytes} byte size limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Validates a local subtitle `file://` URI or absolute filesystem path against the extension
 * allowlist, regular-file `stat`, and size limit (`<= 16 MiB` by default, `#32`, `#308`).
 */
export async function validateLocalSubtitlePath(
  uriOrPath: string,
  maxLocalBytes = DEFAULT_MAX_LOCAL_BYTES,
): Promise<string> {
  if (
    typeof uriOrPath !== 'string' ||
    uriOrPath.length === 0 ||
    uriOrPath.length > MAX_EXTERNAL_SUBTITLE_URI_LENGTH ||
    hasControlChar(uriOrPath)
  ) {
    throw new Error('Invalid local subtitle path');
  }
  const trimmed = uriOrPath.trim();
  let localPath: string;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      localPath = fileURLToPath(trimmed);
    } catch {
      throw new Error('Invalid file:// subtitle URI');
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error('Unsupported local subtitle scheme');
  } else {
    if (!isAbsolute(trimmed)) throw new Error('Local subtitle path must be absolute');
    localPath = trimmed;
  }

  const ext = extname(localPath).slice(1).toLowerCase();
  if (!ALLOWED_EXTENSION_SET.has(ext)) {
    throw new Error(`Unsupported subtitle file extension: .${ext || '(none)'}`);
  }
  const info = await stat(localPath);
  if (!info.isFile()) {
    throw new Error('Selected subtitle path is not a regular file');
  }
  if (info.size > maxLocalBytes) {
    throw new Error(`Local subtitle exceeds ${maxLocalBytes} byte size limit`);
  }
  return localPath;
}

/**
 * Creates a credential-isolated external subtitle fetch & validation session (`#308`).
 * HTTP(S) subtitles are downloaded with zero stream headers/cookies, cross-origin redirect
 * `Authorization`/`Cookie` stripping, and a strict byte cap into a per-session temp directory
 * removed synchronously by `cleanup()`.
 */
export function createSubtitleFetchSession(
  options: SubtitleFetchSessionOptions = {},
): SubtitleFetchSession {
  const http = options.http ?? defaultIsolatedHttpClient;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FETCH_BYTES;
  const maxLocalBytes = options.maxLocalBytes ?? DEFAULT_MAX_LOCAL_BYTES;
  const tempRoot = options.tempRoot ?? tmpdir();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const inFlight = new Set<AbortController>();
  let sessionDir: string | undefined;
  let fileCounter = 0;
  let epoch = 0;

  const ensureSessionDir = (): string => {
    if (sessionDir === undefined) {
      sessionDir = mkdtempSync(join(tempRoot, 'elv-subs-'));
    }
    return sessionDir;
  };

  const cleanup = (): void => {
    epoch += 1;
    for (const controller of [...inFlight]) {
      controller.abort();
    }
    inFlight.clear();
    const dir = sessionDir;
    sessionDir = undefined;
    fileCounter = 0;
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  };

  const fetchHttpTrack = async (
    track: ExternalSubtitleTrack,
    myEpoch: number,
    externalSignal?: AbortSignal,
  ): Promise<string> => {
    const controller = new AbortController();
    inFlight.add(controller);
    const onExternalAbort = (): void => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let currentUrl = new URL(track.uri.trim());
      if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
        throw new Error('Unsupported subtitle HTTP scheme');
      }
      let headers = sanitizeExternalSubtitleHeaders(track.headers);
      let redirects = 0;

      while (true) {
        if (myEpoch !== epoch || controller.signal.aborted) {
          throw new Error('External subtitle fetch aborted');
        }
        const response = await http(currentUrl.href, {
          headers: Object.freeze({ ...headers }),
          signal: controller.signal,
        });

        if (REDIRECT_STATUSES.has(response.statusCode)) {
          response.destroy?.();
          const location = firstHeader(response.headers, 'location');
          if (!location || redirects >= MAX_REDIRECTS) {
            throw new Error('Too many or invalid redirects while fetching subtitle');
          }
          const nextUrl = new URL(location, currentUrl);
          if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
            throw new Error('Subtitle redirect used disallowed scheme');
          }
          if (nextUrl.origin !== currentUrl.origin) {
            headers = stripCrossOriginSensitiveHeaders(headers);
          }
          currentUrl = nextUrl;
          redirects += 1;
          continue;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy?.();
          throw new Error(`Subtitle HTTP status ${response.statusCode}`);
        }

        const contentLength = firstHeader(response.headers, 'content-length');
        if (contentLength !== undefined) {
          const declared = Number.parseInt(contentLength, 10);
          if (Number.isFinite(declared) && declared > maxBytes) {
            response.destroy?.();
            throw new Error(`External subtitle exceeds ${maxBytes} byte size limit`);
          }
        }

        const bytes = await readBoundedBody(
          response.body,
          maxBytes,
          controller.signal,
          response.destroy,
        );
        if (myEpoch !== epoch || controller.signal.aborted) {
          throw new Error('External subtitle fetch aborted');
        }
        const dir = ensureSessionDir();
        fileCounter += 1;
        const ext = inferTempExtension(currentUrl.href, track.mimeType);
        const targetPath = join(dir, `sub-${fileCounter}.${ext}`);
        writeFileSync(targetPath, bytes);
        if (myEpoch !== epoch) {
          try {
            rmSync(targetPath, { force: true });
          } catch {
            // ignore race cleanup error
          }
          throw new Error('External subtitle fetch aborted');
        }
        return targetPath;
      }
    } finally {
      clearTimeout(timeout);
      inFlight.delete(controller);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  };

  return {
    async resolveTrack(track, signal) {
      const myEpoch = epoch;
      const uri = typeof track.uri === 'string' ? track.uri.trim() : '';
      if (
        uri.length === 0 ||
        uri.length > MAX_EXTERNAL_SUBTITLE_URI_LENGTH ||
        hasControlChar(uri)
      ) {
        throw new Error('Invalid external subtitle URI');
      }
      if (/^https?:\/\//i.test(uri)) {
        return fetchHttpTrack(track, myEpoch, signal);
      }
      if (/^file:\/\//i.test(uri) || isAbsolute(uri)) {
        const localPath = await validateLocalSubtitlePath(uri, maxLocalBytes);
        if (myEpoch !== epoch || signal?.aborted) {
          throw new Error('External subtitle validation aborted');
        }
        return localPath;
      }
      throw new Error('Unsupported external subtitle URI scheme');
    },
    cleanup,
  };
}

/**
 * Builds a sandboxed subtitle file picker handler for `player:pick-subtitle-file` (`#32`):
 * opens a single-file dialog filtered to {@link ALLOWED_SUBTITLE_EXTENSIONS}, validates the chosen
 * file, and returns a frozen {@link ExternalSubtitleTrack} or `null`.
 */
export function createSubtitleFilePicker<TWindow = unknown>(
  deps: SubtitleFilePickerDeps<TWindow>,
): (sender: unknown) => Promise<ExternalSubtitleTrack | null> {
  const maxLocalBytes = deps.maxLocalBytes ?? DEFAULT_MAX_LOCAL_BYTES;
  return async (sender) => {
    const win = deps.getWindowFromSender(sender);
    const result = await deps.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Subtitles', extensions: [...ALLOWED_SUBTITLE_EXTENSIONS] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const selectedPath = result.filePaths[0];
    if (!selectedPath) return null;
    const validatedPath = await validateLocalSubtitlePath(selectedPath, maxLocalBytes);
    const uri = pathToFileURL(validatedPath).href;
    const label = basename(validatedPath).trim() || 'subtitle.srt';
    const mimeType = inferSubtitleMimeType(uri);
    return Object.freeze({
      id: `ext-sub-${randomBytes(6).toString('hex')}`,
      uri,
      label,
      mimeType,
    });
  };
}
