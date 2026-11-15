import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Exec } from './adb.ts';
import type { GateDevice } from './gate-device.ts';

const APPLE_SIM_HOST = '127.0.0.1:7878';

const DEFAULT_DEVICE = {
  tvos: 'Apple TV 4K (3rd generation)',
  ios: 'iPhone 17 Pro',
} as const;

const CMD_TIMEOUT_MS = 30_000;
const LOG_TIMEOUT_MS = 60_000;
const BOOT_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 180_000;

interface SimEntry {
  udid?: string;
  name?: string;
  state?: string;
  isAvailable?: boolean;
}

interface RuntimeBucket {
  key: string;
  label: string;
  version: number[];
  devices: SimEntry[];
}

async function call(
  exec: Exec,
  command: string,
  args: string[],
  opts: { timeoutMs?: number; ignoreFailure?: boolean } = {},
): Promise<{ ok: boolean; output: string }> {
  const timeoutMs = opts.timeoutMs ?? CMD_TIMEOUT_MS;
  const result = await exec(command, args, { timeoutMs });
  if (result.timedOut === true) {
    throw new Error(
      `gate: ${command} ${args.join(' ')} timed out after ${Math.round(timeoutMs / 1000)} s`,
    );
  }
  if (!result.ok && opts.ignoreFailure !== true) {
    const tail = result.output.trim().split(/\r?\n/).pop()?.trim() ?? 'non-zero exit';
    throw new Error(`gate: ${command} ${args.slice(0, 2).join(' ')} failed (${tail})`);
  }
  return result;
}

function parseRuntimes(raw: string, platform: 'tvos' | 'ios'): RuntimeBucket[] {
  let parsed: { devices?: Record<string, SimEntry[]> };
  try {
    parsed = JSON.parse(raw) as { devices?: Record<string, SimEntry[]> };
  } catch {
    throw new Error('gate: xcrun simctl list returned invalid JSON');
  }
  const re = platform === 'tvos' ? /(?:^|\.)(tvOS[- ][\d.-]+)$/i : /(?:^|\.)(iOS[- ][\d.-]+)$/i;
  const buckets: RuntimeBucket[] = [];
  for (const [key, list] of Object.entries(parsed.devices ?? {})) {
    const match = re.exec(key);
    if (!match?.[1]) continue;
    const version = (match[1].match(/\d+/g) ?? []).map(Number);
    buckets.push({ key, label: match[1], version, devices: Array.isArray(list) ? list : [] });
  }
  buckets.sort((a, b) => {
    const len = Math.max(a.version.length, b.version.length);
    for (let i = 0; i < len; i++) {
      const diff = (b.version[i] ?? 0) - (a.version[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  return buckets;
}

function formatUtcStart(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}+0000`;
}

function appPid(launchctlOutput: string, bundleId: string): string | null {
  const exact = `UIKitApplication:${bundleId}`;
  const prefix = `${exact}[`;
  for (const line of launchctlOutput.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+\S+\s+(\S+)\s*$/.exec(line);
    const label = match?.[2];
    if (match?.[1] && label !== undefined && (label === exact || label.startsWith(prefix))) {
      return match[1];
    }
  }
  return null;
}

async function plistValue(exec: Exec, plist: string, key: string): Promise<string> {
  const out = await call(exec, '/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
  const value = out.output.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (value === '') throw new Error(`gate: Info.plist in "${plist}" has no ${key}`);
  return value;
}

/** Options of {@link appleSimDevice}. */
export interface AppleSimOptions {
  platform: 'tvos' | 'ios';
  app: string;
  device?: string;
  /** Clock in epoch milliseconds; injected in unit tests. */
  now?: () => number;
  /** Crash reports folder; defaults to `~/Library/Logs/DiagnosticReports`. */
  reportsDir?: string;
}

/**
 * Picks (or creates) an Apple TV or iPhone simulator on the newest available runtime of `platform`, boots it with
 * `simctl bootstatus -b` and returns a {@link GateDevice} targeting `app`.
 */
export async function appleSimDevice(exec: Exec, opts: AppleSimOptions): Promise<GateDevice> {
  const now = opts.now ?? Date.now;
  const reportsDir = opts.reportsDir ?? join(homedir(), 'Library', 'Logs', 'DiagnosticReports');
  const plist = `${opts.app.replace(/\/+$/, '')}/Info.plist`;
  const bundleId = await plistValue(exec, plist, 'CFBundleIdentifier');
  const executable = await plistValue(exec, plist, 'CFBundleExecutable');

  const listing = await call(exec, 'xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
  const runtimes = parseRuntimes(listing.output, opts.platform);
  const newest = runtimes[0];
  if (newest === undefined) {
    throw new Error(`gate: no available ${opts.platform} simulator runtime`);
  }
  const wantedName = opts.device ?? DEFAULT_DEVICE[opts.platform];
  let chosen: { udid: string; name: string; runtime: string; booted: boolean } | undefined;
  for (const bucket of runtimes) {
    const candidates = bucket.devices.filter(
      (d) => d.isAvailable !== false && d.name === wantedName && typeof d.udid === 'string',
    );
    const hit = candidates.find((d) => d.state === 'Booted') ?? candidates[0];
    if (hit?.udid !== undefined) {
      chosen = {
        udid: hit.udid,
        name: wantedName,
        runtime: bucket.label,
        booted: hit.state === 'Booted',
      };
      break;
    }
  }
  if (chosen === undefined) {
    const createdName = `elv-gate-${opts.platform}`;
    const created = await call(exec, 'xcrun', [
      'simctl',
      'create',
      createdName,
      wantedName,
      newest.key,
    ]);
    const udid = created.output.trim().split(/\r?\n/)[0]?.trim() ?? '';
    if (udid === '') throw new Error(`gate: xcrun simctl create returned no UDID`);
    chosen = { udid, name: wantedName, runtime: newest.label, booted: false };
  }

  const { udid, name, runtime } = chosen;
  const bootedByUs = !chosen.booted;
  await call(exec, 'xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeoutMs: BOOT_TIMEOUT_MS });

  let startedAt = formatUtcStart(now());
  let closed = false;

  return {
    simHost: APPLE_SIM_HOST,
    async describe() {
      return { platform: opts.platform, name, runtime, udid };
    },
    async install() {
      await call(exec, 'xcrun', ['simctl', 'install', udid, opts.app], {
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
    },
    async start(url, startOpts) {
      await call(exec, 'xcrun', ['simctl', 'terminate', udid, bundleId], { ignoreFailure: true });
      await startOpts?.afterStop?.();
      startedAt = formatUtcStart(now());
      await call(exec, 'xcrun', ['simctl', 'launch', udid, bundleId, '-gateUrl', url]);
    },
    async stop() {
      await call(exec, 'xcrun', ['simctl', 'terminate', udid, bundleId], { ignoreFailure: true });
    },
    async readLog() {
      const out = await call(
        exec,
        'xcrun',
        [
          'simctl',
          'spawn',
          udid,
          'log',
          'show',
          '--style',
          'compact',
          '--start',
          startedAt,
          '--predicate',
          'eventMessage CONTAINS "ELV_GATE"',
        ],
        { timeoutMs: LOG_TIMEOUT_MS },
      );
      return out.output;
    },
    async crashesSince(epochMs) {
      if (!existsSync(reportsDir)) return [];
      return readdirSync(reportsDir)
        .filter((f) => f.startsWith(executable) && f.endsWith('.ips'))
        .filter((f) => {
          try {
            return statSync(join(reportsDir, f)).mtimeMs >= epochMs;
          } catch {
            return false;
          }
        })
        .sort();
    },
    async memoryMb() {
      const list = await call(exec, 'xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], {
        ignoreFailure: true,
      });
      if (!list.ok) return null;
      const pid = appPid(list.output, bundleId);
      if (pid === null) return null;
      const ps = await call(exec, 'ps', ['-o', 'rss=', '-p', pid], { ignoreFailure: true });
      if (!ps.ok) return null;
      const rssKb = Number(ps.output.trim());
      if (!Number.isFinite(rssKb) || rssKb <= 0) return null;
      return Math.round((rssKb / 1024) * 10) / 10;
    },
    async close() {
      if (!bootedByUs || closed) return;
      closed = true;
      await call(exec, 'xcrun', ['simctl', 'shutdown', udid], { ignoreFailure: true });
    },
  };
}
