import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

/** Supported user feedback categories returned by `/v1/admin/digest`. */
type DigestFeedbackCategory =
  | 'playback_issue'
  | 'channel_epg'
  | 'ui_remote'
  | 'sync_account'
  | 'feature_request'
  | 'other';

/** Per-version and platform aggregated counts. */
interface VersionPlatformRow {
  readonly appVersion: string;
  readonly platform: string;
  readonly events: number;
  readonly sessions: number;
  readonly decodeFailures: number;
  readonly playbackErrors: number;
  readonly feedbackCount: number;
}

/** Latency percentile summary in milliseconds. */
interface LatencySummary {
  readonly count: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

/** Per-screen transition latency breakdown. */
interface ScreenLatencyRow {
  readonly screen: string;
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

/** Per-screen jank and JS-stall hotspot row. */
interface StallHotspotRow {
  readonly screen: string;
  readonly frameJankEvents: number;
  readonly jsStallEvents: number;
  readonly maxDurationMs: number;
}

/** Aggregated stall, jank, SQLite, memory, and playback startup health metrics. */
interface StallAndJankSummary {
  readonly frameJankEvents: number;
  readonly frameJankRatePerSession: number;
  readonly jsStallEvents: number;
  readonly jsStallRatePerSession: number;
  readonly maxStallMs: number | null;
  readonly slowSqliteOps: number;
  readonly slowSqliteP95Ms: number | null;
  readonly memoryPressureEvents: number;
  readonly playbackRebufferEvents: number;
  readonly playbackStartCount: number;
  readonly playbackStartP95Ms: number | null;
  readonly hotspots: readonly StallHotspotRow[];
}

/** Grouped media decode failure signature (#70 signal). */
interface MediaDecodeFailureRow {
  readonly platform: string;
  readonly engine: string;
  readonly container: string;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly errorCode: string;
  readonly hdrFormat: string | null;
  readonly isLive: boolean | null;
  readonly count: number;
}

/** Grouped crash or unhandled error signature with session impact. */
interface CrashAndErrorRow {
  readonly kind: 'app_crash' | 'unhandled_error';
  readonly errorName: string;
  readonly stackSig: string;
  readonly screen: string | null;
  readonly fatalCount: number;
  readonly count: number;
  readonly affectedSessions: number;
}

/** Aggregated catalog / EPG import performance breakdown by source kind. */
interface CatalogImportRow {
  readonly sourceKind: string;
  readonly count: number;
  readonly failureCount: number;
  readonly failureRate: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

/** Aggregated sanitized device technical profile row. */
interface DeviceProfileRow {
  readonly platform: string;
  readonly formFactor: string | null;
  readonly arch: string | null;
  readonly ramBucket: string | null;
  readonly resolution: string | null;
  readonly gpu: string | null;
  readonly locale: string | null;
  readonly sessions: number;
  readonly events: number;
}

/** Recent feedback submission item in the digest. */
interface DigestFeedbackItem {
  readonly id: string;
  readonly receivedAt: string;
  readonly category: DigestFeedbackCategory;
  readonly appVersion: string;
  readonly platform: string;
  readonly locale: string | null;
  readonly message: string;
  readonly hasDiagnostics: boolean;
}

/** Structured report returned by `GET /v1/admin/digest` or read from `--input`. */
export interface TelemetryDigestReport {
  readonly generatedAt: string;
  readonly since: string | null;
  readonly totals: {
    readonly telemetryEvents: number;
    readonly uniqueSessions: number;
    readonly feedbackSubmissions: number;
  };
  readonly pendingAccountDeletionRequests: number;
  readonly versionPlatformMatrix: readonly VersionPlatformRow[];
  readonly startupLatency: LatencySummary;
  readonly screenLatencies: readonly ScreenLatencyRow[];
  readonly stallAndJank: StallAndJankSummary;
  readonly mediaDecodeFailures: readonly MediaDecodeFailureRow[];
  readonly crashesAndErrors: readonly CrashAndErrorRow[];
  readonly catalogImports: readonly CatalogImportRow[];
  readonly deviceProfiles: readonly DeviceProfileRow[];
  readonly feedbackByCategory: Readonly<Record<DigestFeedbackCategory, number>>;
  readonly recentFeedback: readonly DigestFeedbackItem[];
}

/** Parsed CLI arguments for `pnpm telemetry:digest`. */
export interface TelemetryDigestCliOptions {
  readonly input: string | null;
  readonly url: string | null;
  readonly format: 'md' | 'json';
  readonly out: string | null;
  readonly since: string | null;
  readonly help: boolean;
}

/** I/O hooks for testing `runTelemetryDigestCli` without spawning a child process. */
export interface TelemetryDigestCliIo {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: typeof fetch;
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
}

/** Usage string for `pnpm telemetry:digest`. */
const TELEMETRY_DIGEST_USAGE =
  'usage: pnpm telemetry:digest (--input <file.json> | --url <server-url>) [--format md|json] [--out <path>] [--since <iso>]';

const FEEDBACK_CATEGORY_LABELS: Readonly<Record<DigestFeedbackCategory, string>> = {
  playback_issue: 'Playback Issue',
  channel_epg: 'Channel / EPG',
  ui_remote: 'UI & Remote',
  sync_account: 'Sync & Account',
  feature_request: 'Feature Request',
  other: 'Other',
};

const ORDERED_CATEGORIES: readonly DigestFeedbackCategory[] = [
  'playback_issue',
  'channel_epg',
  'ui_remote',
  'sync_account',
  'feature_request',
  'other',
];

/** Parses CLI flags for `telemetry:digest`, falling back to `ELV_SYNC_URL` when `--input` is absent. */
export function parseTelemetryDigestArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): TelemetryDigestCliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      input: { type: 'string' },
      url: { type: 'string' },
      format: { type: 'string', default: 'md' },
      out: { type: 'string' },
      since: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    return { input: null, url: null, format: 'md', out: null, since: null, help: true };
  }

  const formatRaw = (values.format ?? 'md').trim().toLowerCase();
  if (formatRaw !== 'md' && formatRaw !== 'json') {
    throw new Error(`Invalid --format "${values.format ?? ''}"; expected "md" or "json".`);
  }

  const input = values.input?.trim() || null;
  const explicitUrl = values.url?.trim() || null;
  if (input && explicitUrl) {
    throw new Error('Specify either --input or --url, not both.');
  }

  const envUrl = !input ? env.ELV_SYNC_URL?.trim() || null : null;
  const url = explicitUrl ?? envUrl;
  if (!input && !url) {
    throw new Error(
      'Missing data source: provide --input <file.json>, --url <url>, or ELV_SYNC_URL.',
    );
  }

  let since: string | null = null;
  if (values.since !== undefined && values.since.trim().length > 0) {
    const parsedMs = Date.parse(values.since.trim());
    if (Number.isNaN(parsedMs)) {
      throw new Error(`Invalid --since ISO timestamp: "${values.since}".`);
    }
    since = new Date(parsedMs).toISOString();
  }

  const out = values.out?.trim() || null;
  return { input, url, format: formatRaw, out, since, help: false };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validates that parsed JSON matches the `TelemetryDigestReport` contract. */
function assertTelemetryDigestReport(raw: unknown): TelemetryDigestReport {
  if (!isObjectRecord(raw)) {
    throw new Error('Digest payload must be a JSON object.');
  }
  if (
    typeof raw.generatedAt !== 'string' ||
    !isObjectRecord(raw.totals) ||
    typeof raw.totals.telemetryEvents !== 'number' ||
    typeof raw.totals.uniqueSessions !== 'number' ||
    typeof raw.totals.feedbackSubmissions !== 'number' ||
    (raw.pendingAccountDeletionRequests !== undefined &&
      typeof raw.pendingAccountDeletionRequests !== 'number') ||
    !Array.isArray(raw.versionPlatformMatrix) ||
    !isObjectRecord(raw.startupLatency) ||
    !Array.isArray(raw.screenLatencies) ||
    !isObjectRecord(raw.stallAndJank) ||
    !Array.isArray(raw.mediaDecodeFailures) ||
    (raw.crashesAndErrors !== undefined && !Array.isArray(raw.crashesAndErrors)) ||
    (raw.catalogImports !== undefined && !Array.isArray(raw.catalogImports)) ||
    (raw.deviceProfiles !== undefined && !Array.isArray(raw.deviceProfiles)) ||
    !isObjectRecord(raw.feedbackByCategory) ||
    !Array.isArray(raw.recentFeedback)
  ) {
    throw new Error('Digest payload does not match TelemetryDigestReport schema.');
  }
  const normalized = raw as unknown as TelemetryDigestReport;
  return {
    ...normalized,
    pendingAccountDeletionRequests:
      typeof raw.pendingAccountDeletionRequests === 'number'
        ? raw.pendingAccountDeletionRequests
        : 0,
    crashesAndErrors: Array.isArray(raw.crashesAndErrors)
      ? (raw.crashesAndErrors as CrashAndErrorRow[])
      : [],
    catalogImports: Array.isArray(raw.catalogImports)
      ? (raw.catalogImports as CatalogImportRow[])
      : [],
    deviceProfiles: Array.isArray(raw.deviceProfiles)
      ? (raw.deviceProfiles as DeviceProfileRow[])
      : [],
  };
}

/** Loads a `TelemetryDigestReport` from a local JSON file or remote `/v1/admin/digest` endpoint. */
export async function loadTelemetryDigest(
  options: TelemetryDigestCliOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<TelemetryDigestReport> {
  if (options.input) {
    const rawText = readFileSync(options.input, 'utf8');
    const parsed = JSON.parse(rawText) as unknown;
    const report = assertTelemetryDigestReport(parsed);
    if (!options.since) return report;
    const sinceIso = options.since;
    return {
      ...report,
      since: sinceIso,
      recentFeedback: report.recentFeedback.filter((item) => item.receivedAt >= sinceIso),
    };
  }

  if (!options.url) {
    throw new Error('No --url or ELV_SYNC_URL configured.');
  }
  const adminToken = env.ELV_ADMIN_TOKEN?.trim() ?? '';
  if (adminToken.length === 0) {
    throw new Error('ELV_ADMIN_TOKEN environment variable is required when fetching from --url.');
  }

  const base = options.url.replace(/\/+$/, '');
  const endpoint = new URL(`${base}/v1/admin/digest`);
  if (options.since) {
    endpoint.searchParams.set('since', options.since);
  }

  const response = await fetchImpl(endpoint.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${adminToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Digest request failed with HTTP ${response.status} from ${endpoint.origin}.`);
  }
  const body = (await response.json()) as unknown;
  return assertTelemetryDigestReport(body);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function fmtMs(value: number | null): string {
  return value === null ? 'n/a' : `${value} ms`;
}

function fmtLive(value: boolean | null): string {
  if (value === null) return 'n/a';
  return value ? 'Live' : 'VOD';
}

function fmtPercent(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

/** Formats a `TelemetryDigestReport` into a structured, AI-analyzable Markdown report. */
export function formatTelemetryDigestMarkdown(report: TelemetryDigestReport): string {
  const lines: string[] = [];

  lines.push('# ELV IPTV Telemetry & Feedback Digest');
  lines.push('');
  lines.push(`- **Generated At:** \`${report.generatedAt}\``);
  lines.push(`- **Window Since:** ${report.since ? `\`${report.since}\`` : 'All recorded data'}`);
  lines.push('');

  lines.push('## Executive Summary');
  lines.push('');
  lines.push(`- **Telemetry Events:** ${report.totals.telemetryEvents}`);
  lines.push(`- **Unique Sessions:** ${report.totals.uniqueSessions}`);
  lines.push(`- **Feedback Submissions:** ${report.totals.feedbackSubmissions}`);
  lines.push(`- **Pending Account Deletion Requests:** ${report.pendingAccountDeletionRequests}`);
  lines.push(
    `- **Startup Latency:** p50=${fmtMs(report.startupLatency.p50Ms)}, p95=${fmtMs(report.startupLatency.p95Ms)}, max=${fmtMs(report.startupLatency.maxMs)} (n=${report.startupLatency.count})`,
  );

  const slowestScreen = report.screenLatencies[0];
  if (slowestScreen) {
    lines.push(
      `- **Slowest Screen (p95):** \`${escapeCell(slowestScreen.screen)}\` at ${slowestScreen.p95Ms} ms (p50=${slowestScreen.p50Ms} ms, n=${slowestScreen.count})`,
    );
  }
  const topDecode = report.mediaDecodeFailures[0];
  if (topDecode) {
    lines.push(
      `- **Top Media Decode Failure (#70):** \`${escapeCell(topDecode.platform)}\` / \`${escapeCell(topDecode.engine)}\` — \`${escapeCell(topDecode.container)}\` (\`${escapeCell(topDecode.videoCodec)}\` + \`${escapeCell(topDecode.audioCodec)}\`) -> \`${escapeCell(topDecode.errorCode)}\` (${topDecode.count}x)`,
    );
  }
  const topCrash = report.crashesAndErrors[0];
  if (topCrash) {
    lines.push(
      `- **Top Crash / Error:** \`${topCrash.kind}\` — \`${escapeCell(topCrash.errorName)}\` (\`${escapeCell(topCrash.stackSig)}\`, ${topCrash.count}x across ${topCrash.affectedSessions} sessions)`,
    );
  }
  lines.push('');

  lines.push('## Version & Platform Matrix');
  lines.push('');
  if (report.versionPlatformMatrix.length === 0) {
    lines.push('_No telemetry or feedback rows in this window._');
  } else {
    lines.push(
      '| App Version | Platform | Events | Sessions | Decode Failures | Playback Errors | Feedback |',
    );
    lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const row of report.versionPlatformMatrix) {
      lines.push(
        `| ${escapeCell(row.appVersion)} | ${escapeCell(row.platform)} | ${row.events} | ${row.sessions} | ${row.decodeFailures} | ${row.playbackErrors} | ${row.feedbackCount} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Startup & Screen Latency (p50 / p95)');
  lines.push('');
  lines.push(
    `- **App Startup:** count=${report.startupLatency.count}, p50=${fmtMs(report.startupLatency.p50Ms)}, p95=${fmtMs(report.startupLatency.p95Ms)}, max=${fmtMs(report.startupLatency.maxMs)}`,
  );
  lines.push('');
  if (report.screenLatencies.length === 0) {
    lines.push('_No screen transition latency samples recorded._');
  } else {
    lines.push('| Screen | Samples | p50 (ms) | p95 (ms) | Max (ms) |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const row of report.screenLatencies) {
      lines.push(
        `| ${escapeCell(row.screen)} | ${row.count} | ${row.p50Ms} | ${row.p95Ms} | ${row.maxMs} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Stall & Jank Hotspots');
  lines.push('');
  const sj = report.stallAndJank;
  lines.push(
    `- **Frame Jank:** ${sj.frameJankEvents} events (${sj.frameJankRatePerSession} / session)`,
  );
  lines.push(
    `- **JS Stalls:** ${sj.jsStallEvents} events (${sj.jsStallRatePerSession} / session, max=${fmtMs(sj.maxStallMs)})`,
  );
  lines.push(`- **Slow SQLite Ops:** ${sj.slowSqliteOps} (p95=${fmtMs(sj.slowSqliteP95Ms)})`);
  lines.push(
    `- **Memory Pressure Events:** ${sj.memoryPressureEvents} | **Playback Rebuffers:** ${sj.playbackRebufferEvents} | **Playback Start p95:** ${fmtMs(sj.playbackStartP95Ms)} (n=${sj.playbackStartCount})`,
  );
  lines.push('');
  if (sj.hotspots.length === 0) {
    lines.push('_No per-screen jank or stall hotspots recorded._');
  } else {
    lines.push('| Screen | Frame Jank Events | JS Stall Events | Max Duration (ms) |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const h of sj.hotspots) {
      lines.push(
        `| ${escapeCell(h.screen)} | ${h.frameJankEvents} | ${h.jsStallEvents} | ${h.maxDurationMs} |`,
      );
    }
  }
  lines.push('');

  lines.push(
    '## Media Decode Failure Matrix (Container / Video Codec / Audio Codec / Engine — #70 Signal)',
  );
  lines.push('');
  if (report.mediaDecodeFailures.length === 0) {
    lines.push('_No media decode failures recorded in this window._');
  } else {
    lines.push(
      '| Platform | Engine | Container | Video Codec | Audio Codec | HDR | Stream | Error Code | Count |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | ---: |');
    for (const row of report.mediaDecodeFailures) {
      lines.push(
        `| ${escapeCell(row.platform)} | ${escapeCell(row.engine)} | ${escapeCell(row.container)} | ${escapeCell(row.videoCodec)} | ${escapeCell(row.audioCodec)} | ${escapeCell(row.hdrFormat ?? 'sdr')} | ${fmtLive(row.isLive)} | ${escapeCell(row.errorCode)} | ${row.count} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Top Crashes & Unhandled Errors');
  lines.push('');
  if (report.crashesAndErrors.length === 0) {
    lines.push('_No crashes or unhandled errors recorded in this window._');
  } else {
    lines.push(
      '| Kind | Error Name | Stack Signature | Screen | Fatal | Count | Affected Sessions |',
    );
    lines.push('| --- | --- | --- | --- | ---: | ---: | ---: |');
    for (const row of report.crashesAndErrors) {
      lines.push(
        `| ${row.kind} | ${escapeCell(row.errorName)} | ${escapeCell(row.stackSig)} | ${escapeCell(row.screen ?? 'n/a')} | ${row.fatalCount} | ${row.count} | ${row.affectedSessions} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Catalog & EPG Import Performance');
  lines.push('');
  if (report.catalogImports.length === 0) {
    lines.push('_No catalog or EPG import metrics recorded in this window._');
  } else {
    lines.push(
      '| Source Kind | Imports | Failures | Failure Rate | p50 (ms) | p95 (ms) | Max (ms) |',
    );
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of report.catalogImports) {
      lines.push(
        `| ${escapeCell(row.sourceKind)} | ${row.count} | ${row.failureCount} | ${fmtPercent(row.failureRate)} | ${fmtMs(row.p50Ms)} | ${fmtMs(row.p95Ms)} | ${fmtMs(row.maxMs)} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Device Technical Profiles');
  lines.push('');
  if (report.deviceProfiles.length === 0) {
    lines.push('_No device technical profiles recorded in this window._');
  } else {
    lines.push(
      '| Platform | Form Factor | Arch | RAM | Resolution | GPU | Locale | Sessions | Events |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | ---: | ---: |');
    for (const row of report.deviceProfiles) {
      lines.push(
        `| ${escapeCell(row.platform)} | ${escapeCell(row.formFactor ?? 'n/a')} | ${escapeCell(row.arch ?? 'n/a')} | ${escapeCell(row.ramBucket ?? 'n/a')} | ${escapeCell(row.resolution ?? 'n/a')} | ${escapeCell(row.gpu ?? 'n/a')} | ${escapeCell(row.locale ?? 'n/a')} | ${row.sessions} | ${row.events} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Categorized User Feedback');
  lines.push('');
  lines.push('| Category | Submissions |');
  lines.push('| --- | ---: |');
  for (const cat of ORDERED_CATEGORIES) {
    lines.push(
      `| ${FEEDBACK_CATEGORY_LABELS[cat]} (\`${cat}\`) | ${report.feedbackByCategory[cat] ?? 0} |`,
    );
  }
  lines.push('');

  if (report.recentFeedback.length === 0) {
    lines.push('_No recent user feedback submissions._');
  } else {
    lines.push('### Recent Feedback Entries');
    lines.push('');
    for (const item of report.recentFeedback) {
      const diagTag = item.hasDiagnostics ? ' [diagnostics attached]' : '';
      const localeTag = item.locale ? ` · ${escapeCell(item.locale)}` : '';
      lines.push(
        `- **${FEEDBACK_CATEGORY_LABELS[item.category]}** (\`${escapeCell(item.appVersion)}\` · \`${escapeCell(item.platform)}\`${localeTag} · \`${item.receivedAt}\`)${diagTag}: ${escapeCell(item.message)}`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}

/** Runs the `telemetry:digest` CLI end-to-end and returns the process exit code. */
export async function runTelemetryDigestCli(
  argv: readonly string[],
  io: TelemetryDigestCliIo = {},
): Promise<number> {
  const stdout = io.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = io.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const env = io.env ?? process.env;
  const fetchImpl = io.fetchImpl ?? fetch;

  let options: TelemetryDigestCliOptions;
  try {
    options = parseTelemetryDigestArgs(argv, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`${message}\n${TELEMETRY_DIGEST_USAGE}\n`);
    return 2;
  }

  if (options.help) {
    stdout(`${TELEMETRY_DIGEST_USAGE}\n`);
    return 0;
  }

  try {
    const report = await loadTelemetryDigest(options, env, fetchImpl);
    const rendered =
      options.format === 'json'
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatTelemetryDigestMarkdown(report);

    if (options.out) {
      mkdirSync(dirname(options.out), { recursive: true });
      writeFileSync(options.out, rendered, 'utf8');
      stdout(`telemetry:digest: wrote ${options.out}\n`);
    } else {
      stdout(rendered);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`telemetry:digest failed: ${message}\n`);
    return 1;
  }
}
