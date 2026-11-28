import { createHash, timingSafeEqual } from 'node:crypto';
import { type DesktopUpdateState, isAllowedReleasePageUrl } from '../../shared/updater-ipc.ts';
import { isNewerVersion, parseSemver, sanitizeReleaseNotes } from './release-notes-sanitize.ts';

/** Distribution support mode for the desktop auto-updater. */
export type UpdaterSupportMode = 'direct' | 'manual-linux' | 'unsupported';

/** Runtime environment signals inspected by {@link detectUpdaterSupport}. */
export interface UpdaterEnvironment {
  readonly platform: string;
  readonly isPackaged: boolean;
  readonly windowsStore?: boolean;
  readonly mas?: boolean;
  readonly appImage?: string | undefined;
}

/** Normalized latest-release metadata returned by a check provider. */
export interface ReleaseCheckResult {
  readonly version: string;
  readonly releaseNotes?: string;
  readonly releasePageUrl?: string;
  readonly assetUrl?: string;
  readonly expectedSha256?: string;
  readonly isPrerelease?: boolean;
}

/** Context handed to a pluggable download & checksum-verification driver. */
interface DownloadVerifyContext {
  readonly version: string;
  readonly assetUrl?: string;
  readonly expectedSha256?: string;
  readonly manualDownloadUrl?: string;
  readonly onProgress: (percent: number) => void;
}

/** Result returned by a pluggable download & verification driver. */
type DownloadVerifyResult =
  | {
      readonly verified: true;
      readonly actualSha256?: string;
      readonly bytes?: Uint8Array;
      readonly downloadedPath?: string;
    }
  | {
      readonly verified: false;
      readonly fallbackToManual?: boolean;
      readonly errorCode?: string;
    };

/** Collaborators injected into {@link createDesktopUpdaterService}. */
export interface DesktopUpdaterServiceDeps {
  readonly currentVersion: string;
  readonly env: UpdaterEnvironment;
  readonly checkProvider?: () => Promise<ReleaseCheckResult | null>;
  readonly downloadAndVerify?: (ctx: DownloadVerifyContext) => Promise<DownloadVerifyResult>;
  readonly beforeShutdown?: () => Promise<void> | void;
  readonly shutdownCatalog?: () => Promise<void> | void;
  readonly quitAndInstall?: () => Promise<void> | void;
  readonly now?: () => string;
  readonly log?: (line: string) => void;
}

/** Store-gated desktop auto-updater service running in Electron main. */
export interface DesktopUpdaterService {
  readonly support: UpdaterSupportMode;
  getState(): DesktopUpdateState;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  getManualDownloadUrl(): string | null;
  subscribe(listener: (state: DesktopUpdateState) => void): () => void;
}

/** Options for {@link createGitHubReleasesCheckProvider}. */
export interface GitHubReleasesProviderOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly apiUrl?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

const GITHUB_LATEST_RELEASE_API =
  'https://api.github.com/repos/fatihmutluu/elv-iptv/releases/latest';
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const SAFE_TAG_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Classifies how updates should operate in the current packaged/runtime environment:
 * - Store builds (`windowsStore` MSIX or `mas` Mac App Store) are strictly `'unsupported'`.
 * - Linux uses `'direct'` only for packaged AppImage runs (`isPackaged && APPIMAGE`), otherwise
 *   `'manual-linux'` (release page handoff only).
 * - Windows and macOS return `'direct'` (unpackaged dev builds stay checkable via release page
 *   handoff without executing self-update binaries).
 */
export function detectUpdaterSupport(env: UpdaterEnvironment): UpdaterSupportMode {
  if (env.windowsStore === true || env.mas === true) return 'unsupported';
  if (env.platform === 'linux') {
    return env.isPackaged && typeof env.appImage === 'string' && env.appImage.trim().length > 0
      ? 'direct'
      : 'manual-linux';
  }
  if (env.platform === 'win32' || env.platform === 'darwin') return 'direct';
  return 'unsupported';
}

/** Parses standard `SHA256SUMS` text (`<64-hex>  <filename>`) into a filename -> lowercase hex map. */
export function parseSha256Sums(raw: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) continue;
    const hash = match[1]?.toLowerCase();
    const fileName = match[2]?.trim();
    if (hash && fileName) result.set(fileName, hash);
  }
  return result;
}

/** Timing-safe SHA-256 verification of raw bytes against an expected 64-char hex digest. */
export function verifySha256Digest(bytes: Uint8Array, expectedHex: string): boolean {
  if (!SHA256_HEX_PATTERN.test(expectedHex)) return false;
  const actualHex = createHash('sha256').update(bytes).digest('hex');
  return compareHexDigests(actualHex, expectedHex);
}

function compareHexDigests(actualHex: string, expectedHex: string): boolean {
  if (!SHA256_HEX_PATTERN.test(actualHex) || !SHA256_HEX_PATTERN.test(expectedHex)) return false;
  const a = Buffer.from(actualHex.toLowerCase(), 'hex');
  const b = Buffer.from(expectedHex.toLowerCase(), 'hex');
  if (a.byteLength !== 32 || b.byteLength !== 32) return false;
  return timingSafeEqual(a, b);
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw new DOMException('release response aborted', 'AbortError');
  }
  const headerLength = response.headers.get('content-length');
  if (headerLength !== null) {
    const parsedLen = Number(headerLength);
    if (Number.isFinite(parsedLen) && parsedLen > maxBytes) {
      throw new Error('release response exceeded maximum size limit');
    }
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        if (signal?.aborted) {
          throw new DOMException('release response aborted', 'AbortError');
        }
        const { done, value } = await reader.read();
        if (signal?.aborted) {
          throw new DOMException('release response aborted', 'AbortError');
        }
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error('release response exceeded maximum size limit');
          }
          chunks.push(value);
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total).toString('utf8');
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  if (signal?.aborted) {
    throw new DOMException('release response aborted', 'AbortError');
  }
  if (buffer.byteLength > maxBytes) {
    throw new Error('release response exceeded maximum size limit');
  }
  return Buffer.from(buffer).toString('utf8');
}

/**
 * Builds the default GitHub Releases check provider targeting ELV IPTV's official repository with
 * a strict 10 s timeout covering both headers and body read, 512 KiB response size cap, and strict
 * HTTPS release URL allowlisting.
 */
export function createGitHubReleasesCheckProvider(
  options: GitHubReleasesProviderOptions = {},
): () => Promise<ReleaseCheckResult | null> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const apiUrl = options.apiUrl ?? GITHUB_LATEST_RELEASE_API;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return async (): Promise<ReleaseCheckResult | null> => {
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch_unavailable');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref?: () => void }).unref?.();
    }
    let bodyText: string;
    try {
      const response = await fetchImpl(apiUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ELV-IPTV-Desktop-Updater',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`http_${response.status}`);
      }
      bodyText = await readBoundedText(response, maxBytes, controller.signal);
    } finally {
      clearTimeout(timer);
    }

    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('invalid_release_payload');
    }
    const record = parsed as Record<string, unknown>;
    if (record['draft'] === true) return null;

    const rawTag = typeof record['tag_name'] === 'string' ? record['tag_name'].trim() : '';
    const parsedVersion = parseSemver(rawTag);
    if (parsedVersion === null) {
      throw new Error('invalid_release_version');
    }
    const normalizedVersion = rawTag.startsWith('v') ? rawTag.slice(1) : rawTag;

    const rawHtmlUrl = record['html_url'];
    let releasePageUrl: string;
    if (rawHtmlUrl !== undefined) {
      if (!isAllowedReleasePageUrl(rawHtmlUrl)) {
        throw new Error('invalid_release_url');
      }
      releasePageUrl = rawHtmlUrl;
    } else if (SAFE_TAG_PATTERN.test(rawTag)) {
      releasePageUrl = `https://github.com/fatihmutluu/elv-iptv/releases/tag/${rawTag}`;
    } else {
      throw new Error('invalid_release_url');
    }

    const releaseNotes = typeof record['body'] === 'string' ? record['body'] : '';
    const isPrerelease = record['prerelease'] === true;

    return {
      version: normalizedVersion,
      releaseNotes,
      releasePageUrl,
      isPrerelease,
    };
  };
}

function classifyErrorCode(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw === 'invalid_release_url') return 'invalid_release_url';
  if (raw === 'checksum_mismatch' || /checksum/i.test(raw)) return 'checksum_mismatch';
  if (/maximum size limit|response_too_large/i.test(raw)) return 'response_too_large';
  if (
    (err instanceof Error && err.name === 'AbortError') ||
    /\b(?:abort|aborted|timeout)\b/i.test(raw)
  ) {
    return 'timeout';
  }
  if (/^http_\d+$/i.test(raw)) return raw.toLowerCase();
  return 'check_failed';
}

/**
 * Creates the store-gated desktop auto-updater service (`F-13`).
 * - Store builds (`windowsStore` / `mas`) stay strictly `'unsupported'` with zero network calls.
 * - Updates are strictly user-initiated (never auto-downloaded without explicit consent).
 * - Direct installs strictly verify SHA-256 checksums and flush `beforeShutdown` + `shutdownCatalog`
 *   before invoking `quitAndInstall` (guarded against re-entrancy).
 */
export function createDesktopUpdaterService(
  deps: DesktopUpdaterServiceDeps,
): DesktopUpdaterService {
  const support = detectUpdaterSupport(deps.env);
  const currentVersion = deps.currentVersion.trim() || '0.0.0';
  const now = deps.now ?? (() => new Date().toISOString());
  const checkProvider = deps.checkProvider ?? createGitHubReleasesCheckProvider();
  const listeners = new Set<(state: DesktopUpdateState) => void>();

  let state: DesktopUpdateState = Object.freeze({
    status: support === 'unsupported' ? 'unsupported' : 'idle',
    currentVersion,
  });

  let latestRelease: ReleaseCheckResult | null = null;
  let latestReleasePageUrl: string | null = null;
  let inFlightCheck: Promise<DesktopUpdateState> | null = null;
  let inFlightDownload: Promise<DesktopUpdateState> | null = null;
  let inFlightInstall: Promise<void> | null = null;

  const setState = (next: DesktopUpdateState): DesktopUpdateState => {
    state = Object.freeze({ ...next });
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // Isolate subscriber failures.
      }
    }
    return state;
  };

  return {
    support,

    getState(): DesktopUpdateState {
      return state;
    },

    getManualDownloadUrl(): string | null {
      if (support === 'unsupported') return null;
      return latestReleasePageUrl;
    },

    subscribe(listener: (next: DesktopUpdateState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async checkForUpdates(): Promise<DesktopUpdateState> {
      if (support === 'unsupported') return state;
      if (inFlightInstall !== null || state.status === 'downloading') return state;
      if (inFlightCheck !== null) return inFlightCheck;

      const task = (async (): Promise<DesktopUpdateState> => {
        setState({ status: 'checking', currentVersion });
        const checkedAt = now();
        try {
          const release = await checkProvider();
          if (release === null) {
            latestRelease = null;
            latestReleasePageUrl = null;
            return setState({ status: 'up-to-date', currentVersion, checkedAt });
          }

          const candidateVersion = release.version.trim().replace(/^v/, '');
          const isPrereleaseFlagged = release.isPrerelease === true;
          const currentParsed = parseSemver(currentVersion);
          const currentIsPrerelease = (currentParsed?.prerelease.length ?? 0) > 0;

          if (
            (isPrereleaseFlagged && !currentIsPrerelease) ||
            !isNewerVersion(candidateVersion, currentVersion)
          ) {
            latestRelease = null;
            latestReleasePageUrl = null;
            return setState({ status: 'up-to-date', currentVersion, checkedAt });
          }

          if (
            release.releasePageUrl !== undefined &&
            !isAllowedReleasePageUrl(release.releasePageUrl)
          ) {
            throw new Error('invalid_release_url');
          }

          const safeReleaseUrl =
            release.releasePageUrl ??
            (SAFE_TAG_PATTERN.test(candidateVersion)
              ? `https://github.com/fatihmutluu/elv-iptv/releases/tag/v${candidateVersion}`
              : undefined);
          if (safeReleaseUrl !== undefined && !isAllowedReleasePageUrl(safeReleaseUrl)) {
            throw new Error('invalid_release_url');
          }

          const sanitizedNotes = sanitizeReleaseNotes(release.releaseNotes ?? '');
          latestRelease = release;
          latestReleasePageUrl = safeReleaseUrl ?? null;

          const canDirectDownload =
            support === 'direct' &&
            deps.env.isPackaged &&
            deps.downloadAndVerify !== undefined &&
            typeof release.expectedSha256 === 'string' &&
            SHA256_HEX_PATTERN.test(release.expectedSha256);

          return setState({
            status: 'available',
            currentVersion,
            availableVersion: candidateVersion,
            ...(sanitizedNotes.length > 0 ? { releaseNotes: sanitizedNotes } : {}),
            ...(!canDirectDownload && safeReleaseUrl !== undefined
              ? { manualDownloadUrl: safeReleaseUrl }
              : {}),
            checkedAt,
          });
        } catch (err) {
          latestRelease = null;
          latestReleasePageUrl = null;
          const errorCode = classifyErrorCode(err);
          deps.log?.(`updater: check failed (${errorCode})`);
          return setState({
            status: 'error',
            currentVersion,
            errorCode,
            checkedAt,
          });
        } finally {
          inFlightCheck = null;
        }
      })();

      inFlightCheck = task;
      return task;
    },

    async downloadUpdate(): Promise<DesktopUpdateState> {
      if (support !== 'direct' || inFlightInstall !== null) return state;
      if (inFlightDownload !== null) return inFlightDownload;
      if (state.status !== 'available' || latestRelease === null) return state;

      const release = latestRelease;
      const availableVersion = state.availableVersion ?? release.version.trim().replace(/^v/, '');
      const releaseNotes = state.releaseNotes;
      const checkedAt = state.checkedAt;
      const manualUrl = latestReleasePageUrl ?? undefined;

      if (
        !deps.env.isPackaged ||
        deps.downloadAndVerify === undefined ||
        typeof release.expectedSha256 !== 'string' ||
        !SHA256_HEX_PATTERN.test(release.expectedSha256)
      ) {
        return setState({
          status: 'available',
          currentVersion,
          availableVersion,
          ...(releaseNotes !== undefined ? { releaseNotes } : {}),
          ...(manualUrl !== undefined ? { manualDownloadUrl: manualUrl } : {}),
          ...(checkedAt !== undefined ? { checkedAt } : {}),
        });
      }

      const driver = deps.downloadAndVerify;
      const expectedSha256 = release.expectedSha256;

      const task = (async (): Promise<DesktopUpdateState> => {
        let lastPercent = 0;
        setState({
          status: 'downloading',
          currentVersion,
          availableVersion,
          ...(releaseNotes !== undefined ? { releaseNotes } : {}),
          downloadPercent: 0,
          ...(checkedAt !== undefined ? { checkedAt } : {}),
        });

        try {
          const outcome = await driver({
            version: availableVersion,
            ...(release.assetUrl !== undefined ? { assetUrl: release.assetUrl } : {}),
            expectedSha256,
            ...(manualUrl !== undefined ? { manualDownloadUrl: manualUrl } : {}),
            onProgress: (rawPercent) => {
              if (!Number.isFinite(rawPercent)) return;
              const clamped = Math.max(0, Math.min(100, Math.round(rawPercent)));
              if (clamped === lastPercent || state.status !== 'downloading') return;
              lastPercent = clamped;
              setState({
                status: 'downloading',
                currentVersion,
                availableVersion,
                ...(releaseNotes !== undefined ? { releaseNotes } : {}),
                downloadPercent: clamped,
                ...(checkedAt !== undefined ? { checkedAt } : {}),
              });
            },
          });

          if (!outcome.verified) {
            if (outcome.fallbackToManual === true && manualUrl !== undefined) {
              return setState({
                status: 'available',
                currentVersion,
                availableVersion,
                ...(releaseNotes !== undefined ? { releaseNotes } : {}),
                manualDownloadUrl: manualUrl,
                ...(checkedAt !== undefined ? { checkedAt } : {}),
              });
            }
            return setState({
              status: 'error',
              currentVersion,
              availableVersion,
              ...(releaseNotes !== undefined ? { releaseNotes } : {}),
              ...(manualUrl !== undefined ? { manualDownloadUrl: manualUrl } : {}),
              errorCode: outcome.errorCode ?? 'download_failed',
              ...(checkedAt !== undefined ? { checkedAt } : {}),
            });
          }

          const digestValid =
            outcome.bytes !== undefined
              ? verifySha256Digest(outcome.bytes, expectedSha256)
              : outcome.actualSha256 !== undefined
                ? compareHexDigests(outcome.actualSha256, expectedSha256)
                : false;

          if (!digestValid) {
            deps.log?.('updater: SHA-256 checksum mismatch on downloaded installer');
            return setState({
              status: 'error',
              currentVersion,
              availableVersion,
              ...(releaseNotes !== undefined ? { releaseNotes } : {}),
              ...(manualUrl !== undefined ? { manualDownloadUrl: manualUrl } : {}),
              errorCode: 'checksum_mismatch',
              ...(checkedAt !== undefined ? { checkedAt } : {}),
            });
          }

          return setState({
            status: 'downloaded',
            currentVersion,
            availableVersion,
            ...(releaseNotes !== undefined ? { releaseNotes } : {}),
            downloadPercent: 100,
            ...(checkedAt !== undefined ? { checkedAt } : {}),
          });
        } catch (err) {
          const errorCode = classifyErrorCode(err);
          deps.log?.(`updater: download failed (${errorCode})`);
          return setState({
            status: 'error',
            currentVersion,
            availableVersion,
            ...(releaseNotes !== undefined ? { releaseNotes } : {}),
            ...(manualUrl !== undefined ? { manualDownloadUrl: manualUrl } : {}),
            errorCode,
            ...(checkedAt !== undefined ? { checkedAt } : {}),
          });
        } finally {
          inFlightDownload = null;
        }
      })();

      inFlightDownload = task;
      return task;
    },

    async installUpdate(): Promise<void> {
      if (support !== 'direct' || !deps.env.isPackaged || state.status !== 'downloaded') return;
      if (inFlightInstall !== null) return inFlightInstall;

      const task = (async (): Promise<void> => {
        try {
          try {
            await deps.beforeShutdown?.();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            deps.log?.(`updater: beforeShutdown error before install (${msg})`);
          }
          try {
            await deps.shutdownCatalog?.();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            deps.log?.(`updater: shutdownCatalog error before install (${msg})`);
          }
          await deps.quitAndInstall?.();
        } finally {
          inFlightInstall = null;
        }
      })();

      inFlightInstall = task;
      return task;
    },
  };
}
