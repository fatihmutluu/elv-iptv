import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { buildCatalog } from '../sim/catalog.ts';
import { findFfmpeg } from '../sim/media.ts';
import { startSim } from '../sim/server.ts';
import type { Exec } from './adb.ts';
import { type AppHandle, readUntil, waitExit } from './app-lines.ts';
import {
  aggregateDesktopRuns,
  DESKTOP_FAULTS,
  type DesktopFault,
  type DesktopFaultReport,
  type DesktopLine,
  type DesktopResult,
  judgeDesktopFault,
  type OrphanReport,
  parseDesktopLine,
} from './desktop-compare.ts';
import { connectionStats, httpSimLog, type SimLogEntry, STREAM_PATH } from './sim-log.ts';

export type { AppHandle } from './app-lines.ts';
export { connectionStats } from './sim-log.ts';

const ACCOUNT = 'demo';
const ZAP_RATE = 0.5;
const FAULT_RATE = 0.1;
const SILENT_FAULT_RATE = 0.05;
const SLOW_START_RATE = 1.25;
const LINE_MARGIN_MS = 75_000;
const ORPHAN_PLAYING_TIMEOUT_MS = 20_000;
const ORPHAN_LIMIT_MS = 2000;
const ORPHAN_POLL_TIMEOUT_MS = 5000;
const ORPHAN_POLL_MS = 50;

interface DesktopSimHandle {
  readonly url: string;
  requests(): Promise<SimLogEntry[]>;
  clearRequests(): Promise<void>;
  close(): Promise<void>;
}

/** Injectable system dependencies of {@link runDesktopGate}. */
export interface DesktopGateDeps {
  startSim: () => Promise<DesktopSimHandle>;
  spawnApp: (args: readonly string[]) => AppHandle;
  buildApp?: () => Promise<void>;
  ffmpeg?: () => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Options of {@link runDesktopGate}. */
export interface DesktopGateOptions {
  build?: boolean;
  runs?: number;
  zaps?: number;
  faults?: boolean;
  simUrl?: string;
  onRun?: (run: DesktopResult) => void;
  onFault?: (report: DesktopFaultReport) => void;
  onOrphan?: (report: OrphanReport) => void;
  onNote?: (note: string) => void;
}

/** Output of {@link runDesktopGate}. */
export interface DesktopGateResult {
  result: DesktopResult;
  runs: DesktopResult[];
  faults: DesktopFaultReport[];
  orphan: OrphanReport | null;
}

/** Default baseline path for `platform`. */
export function defaultDesktopBaseline(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'docs/learned/gates/player-desktop-windows.json';
  if (platform === 'darwin') return 'docs/learned/gates/player-desktop-macos.json';
  return 'docs/learned/gates/player-desktop-linux.json';
}

/** Picks the first four healthy `h264-aac-720p25` live channels and the first H.264 MP4 VOD from `buildCatalog('small', 1)`. */
export function desktopGateCatalog(): { channels: string[]; vod: string } {
  const catalog = buildCatalog('small', 1);
  const channels = catalog.live
    .filter((c) => c.recipe === 'h264-aac-720p25' && c.fault === null)
    .slice(0, 4)
    .map((c) => String(c.id));
  const movie = catalog.movies.find((m) => m.recipe === 'h264-aac-720p25' && m.ext === 'mp4');
  if (channels.length === 0 || movie === undefined) {
    throw new Error(
      'gate: small catalog has no healthy h264-aac-720p25 live channels or MP4 movie',
    );
  }
  return { channels, vod: String(movie.id) };
}

function gateQuery(p: {
  base: string;
  channels: readonly string[];
  zaps: number;
  rate: number;
  vod: string | null;
  fault: string;
}): string {
  const parts = [
    'elv-gate=player',
    `base=${p.base}`,
    `account=${ACCOUNT}`,
    `channels=${p.channels.join(',')}`,
    `zaps=${p.zaps}`,
    `rate=${p.rate}`,
  ];
  if (p.vod !== null) parts.push(`vod=${p.vod}`);
  parts.push(`fault=${p.fault}`);
  return parts.join('&');
}

/** Runs the desktop player zap, fault and orphan gate. */
export async function runDesktopGate(
  opts: DesktopGateOptions,
  deps: DesktopGateDeps,
): Promise<DesktopGateResult> {
  const externalSim = opts.simUrl !== undefined;
  if (!externalSim && (deps.ffmpeg ?? findFfmpeg)() === null) {
    throw new Error(
      'gate: FFmpeg not found: set FFMPEG_PATH or install FFmpeg; the simulator needs it for live streams',
    );
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const runs = Math.max(1, opts.runs ?? 3);
  const zaps = opts.zaps ?? 30;
  const { channels, vod } = desktopGateCatalog();

  if (opts.build === true && deps.buildApp) await deps.buildApp();

  const sim: DesktopSimHandle = externalSim
    ? (() => {
        const url = (opts.simUrl as string).replace(/\/+$/, '');
        const log = httpSimLog(url);
        return {
          url,
          requests: () => log.entries(),
          clearRequests: () => log.clear(),
          close: async () => {},
        };
      })()
    : await deps.startSim();

  try {
    if (externalSim) opts.onNote?.(`using external simulator at ${sim.url}`);

    const playOne = async (
      query: string,
      stayMs: number,
    ): Promise<{ line: DesktopLine; entries: SimLogEntry[] }> => {
      await sim.clearRequests();
      const app = deps.spawnApp([`--elv-gate=${query}`]);
      const timeoutMs = stayMs + LINE_MARGIN_MS;
      let line: DesktopLine;
      try {
        line = await readUntil(
          app.lines,
          (raw) => parseDesktopLine(raw),
          timeoutMs,
          () =>
            new Error(
              `gate: no ELV_GATE_PLAYER line within ${Math.round(timeoutMs / 1000)} s; the desktop run did not finish`,
            ),
        );
      } catch (error) {
        app.kill();
        throw error;
      }
      await waitExit(app, 3000);
      await sleep(100);
      return { line, entries: await sim.requests() };
    };

    const lines: DesktopLine[] = [];
    const stats: { limitResponses: number; overlapMs: number }[] = [];
    for (let i = 0; i < runs; i++) {
      const q = gateQuery({ base: sim.url, channels, zaps, rate: ZAP_RATE, vod, fault: '' });
      const { line, entries } = await playOne(q, (zaps / ZAP_RATE) * 1000);
      if (line.fault !== '' || line.zaps < zaps) {
        throw new Error(
          `gate: desktop ran fault "${line.fault}" with ${line.zaps} zaps, requested no fault and ${zaps} zaps`,
        );
      }
      const stat = connectionStats(entries, ACCOUNT);
      lines.push(line);
      stats.push(stat);
      opts.onRun?.(aggregateDesktopRuns([line], [stat]));
    }

    const faults: DesktopFaultReport[] = [];
    let orphan: OrphanReport | null = null;
    if (opts.faults === true) {
      for (const fault of DESKTOP_FAULTS) {
        const rate =
          fault === 'slowstart'
            ? SLOW_START_RATE
            : fault === 'silent'
              ? SILENT_FAULT_RATE
              : FAULT_RATE;
        const q = gateQuery({
          base: sim.url,
          channels,
          zaps: 1,
          rate,
          vod: null,
          fault,
        });
        const { line, entries } = await playOne(q, (1 / rate) * 1000);
        const verdict = judgeDesktopFault(
          fault as DesktopFault,
          line,
          entries,
          channels[0] as string,
        );
        const report: DesktopFaultReport = {
          fault,
          line,
          ...verdict,
          ...connectionStats(entries, ACCOUNT),
        };
        faults.push(report);
        opts.onFault?.(report);
      }
      orphan = await runOrphan(sim, deps, channels[0] as string, externalSim, now, sleep);
      opts.onOrphan?.(orphan);
    }

    const perRun = lines.map((l, i) =>
      aggregateDesktopRuns([l], [stats[i] as (typeof stats)[number]]),
    );
    return { result: aggregateDesktopRuns(lines, stats), runs: perRun, faults, orphan };
  } finally {
    await sim.close();
  }
}

async function runOrphan(
  sim: DesktopSimHandle,
  deps: DesktopGateDeps,
  channel: string,
  externalSim: boolean,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<OrphanReport> {
  await sim.clearRequests();
  const q = gateQuery({
    base: sim.url,
    channels: [channel],
    zaps: 1,
    rate: 0.1,
    vod: null,
    fault: '',
  });
  const app = deps.spawnApp([`--elv-gate=${q}`]);
  try {
    await readUntil(
      app.lines,
      (raw) => (raw.trim() === 'ELV_GATE_PLAYING' ? true : undefined),
      ORPHAN_PLAYING_TIMEOUT_MS,
      () => new Error('orphan: app did not reach playing within 20 s'),
    );
  } catch (error) {
    app.kill();
    return { ok: false, closeMs: null, failures: [(error as Error).message] };
  }

  const killedAt = now();
  app.kill();

  for (let waited = 0; waited <= ORPHAN_POLL_TIMEOUT_MS; waited += ORPHAN_POLL_MS) {
    const entries = await sim.requests();
    const closed = entries.find((e) => e.account === ACCOUNT && STREAM_PATH.test(e.path));
    if (closed !== undefined) {
      const seenAt = now();
      const parsedEnd = Date.parse(closed.t);
      const closeMs =
        !externalSim && Number.isFinite(parsedEnd)
          ? Math.max(0, parsedEnd - killedAt)
          : Math.max(0, seenAt - killedAt);
      const ok = closeMs <= ORPHAN_LIMIT_MS;
      return {
        ok,
        closeMs,
        failures: ok
          ? []
          : [
              `orphan: stream closed ${closeMs} ms after main was killed, limit ${ORPHAN_LIMIT_MS} ms`,
            ],
      };
    }
    await sleep(ORPHAN_POLL_MS);
  }
  return {
    ok: false,
    closeMs: null,
    failures: [
      `orphan: stream did not close within ${ORPHAN_POLL_TIMEOUT_MS} ms after main was killed (limit ${ORPHAN_LIMIT_MS} ms)`,
    ],
  };
}

/** Production system dependencies for `pnpm gate desktop`. */
export function systemDesktopDeps(root: string, exec: Exec): DesktopGateDeps {
  const desktopDir = resolve(root, 'apps', 'desktop');
  const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return {
    buildApp: async () => {
      const res = await exec(pnpmCmd, ['--filter', '@elv/desktop', 'run', 'prepare:app']);
      if (!res.ok) throw new Error(`gate: desktop prepare:app failed:\n${res.output}`);
    },
    startSim: async () => {
      const handle = await startSim({ port: 0, host: '127.0.0.1', seed: 1 });
      return {
        url: handle.url,
        requests: async () => handle.requests(),
        clearRequests: async () => handle.clear(),
        close: () => handle.close(),
      };
    },
    spawnApp: (args) => {
      const req = createRequire(resolve(desktopDir, 'package.json'));
      const electronBin = req('electron') as string;
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      const child = spawn(electronBin, ['.', ...args], {
        cwd: desktopDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr?.on('data', () => {
        // drain stderr so Electron never blocks on a full pipe
      });
      const rl = createInterface({ input: child.stdout });
      const exited = new Promise<number | null>((resolveExit) => {
        child.once('exit', (code) => {
          rl.close();
          resolveExit(code);
        });
        child.once('error', () => {
          rl.close();
          resolveExit(null);
        });
      });
      return {
        pid: child.pid ?? 0,
        lines: rl,
        exited,
        kill: () => {
          if (child.pid) {
            try {
              process.kill(child.pid, 'SIGKILL');
            } catch {
              // already exited
            }
          }
        },
      };
    },
  };
}
