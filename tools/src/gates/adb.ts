import { existsSync } from 'node:fs';
import { buildPrebuildCommand } from '../run-command.ts';

/** Package of the development variant, the only one that contains the gate screen. */
export const APP_PACKAGE = 'io.github.fatihmutluu.elviptv.dev';
const APK = 'apps/tv-mobile/android/app/build/outputs/apk/release/app-release.apk';
export const POLL_MS = 1000;
const ADB_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const FOREGROUND_POLLS = 8;
const KEY_BACK = '4';

/** Runs one adb command with a timeout; a hung command throws instead of blocking the gate. */
async function adbCall(
  exec: Exec,
  adb: string,
  args: string[],
  timeoutMs = ADB_TIMEOUT_MS,
): Promise<ExecResult> {
  const result = await exec(adb, args, { timeoutMs });
  if (result.timedOut === true) {
    const shown = args[0] === '-s' ? args.slice(2) : args;
    throw new Error(
      `gate: adb ${shown.join(' ')} timed out after ${Math.round(timeoutMs / 1000)} s`,
    );
  }
  return result;
}

/** Output of a finished process. */
interface ExecResult {
  ok: boolean;
  output: string;
  /** The process was killed because it ran longer than `timeoutMs`. */
  timedOut?: boolean;
}

/** Runs a process and captures its combined output; injected so tests never start adb. */
export type Exec = (
  command: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<ExecResult>;

/** Finds adb in `ANDROID_HOME`, `ANDROID_SDK_ROOT` or the default SDK folder, else relies on PATH. */
export function resolveAdb(
  env: Record<string, string | undefined>,
  platform: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const win = platform === 'win32';
  const name = win ? 'adb.exe' : 'adb';
  const sep = win ? '\\' : '/';
  const home = win ? env.LOCALAPPDATA : env.HOME;
  const defaultSdk =
    home === undefined ? undefined : `${home}${sep}${win ? 'Android\\Sdk' : 'Android/Sdk'}`;
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, defaultSdk]) {
    if (sdk === undefined || sdk === '') continue;
    const candidate = `${sdk}${sep}platform-tools${sep}${name}`;
    if (exists(candidate)) return candidate;
  }
  return 'adb';
}

/** The resumed activity (`package/.Class`) from `dumpsys activity activities`, or undefined. */
export function topActivity(dump: string): string | undefined {
  const match = /topResumedActivity=ActivityRecord\{\S+ \S+ (\S+)/.exec(dump);
  return match?.[1];
}

/** Serial of the device to measure: the emulator running `avd`, or the only attached device. */
export async function findDevice(exec: Exec, adb: string, avd?: string): Promise<string> {
  const listing = await adbCall(exec, adb, ['devices']);
  const serials = listing.output
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((cols) => cols[1]?.trim() === 'device')
    .map((cols) => cols[0] as string);
  if (avd !== undefined) {
    for (const serial of serials) {
      const name = await adbCall(exec, adb, ['-s', serial, 'emu', 'avd', 'name']);
      if (name.output.split(/\r?\n/)[0]?.trim() === avd) return serial;
    }
    throw new Error(
      `gate: no running emulator for AVD "${avd}"; start it with: emulator -avd ${avd}`,
    );
  }
  if (serials.length === 0) {
    throw new Error('gate: no device attached; start an Android TV emulator');
  }
  if (serials.length > 1) {
    throw new Error(
      `gate: ${serials.length} devices attached (${serials.join(', ')}); pass --avd <name>`,
    );
  }
  return serials[0] as string;
}

/** Product name, Android release and API level of a device, for the baseline metadata. */
export async function deviceInfo(
  exec: Exec,
  adb: string,
  serial: string,
): Promise<{ model: string; release: string; sdk: string }> {
  const prop = async (name: string) =>
    (await adbCall(exec, adb, ['-s', serial, 'shell', 'getprop', name])).output.trim();
  return {
    model: await prop('ro.product.name'),
    release: await prop('ro.build.version.release'),
    sdk: await prop('ro.build.version.sdk'),
  };
}

export async function buildApk(exec: Exec, root: string, adb: string): Promise<void> {
  const sdk = /^(.*)[\\/]platform-tools[\\/][^\\/]*$/.exec(adb)?.[1];
  const prebuild = buildPrebuildCommand({
    target: 'android-tv',
    variant: 'development',
    devEnv: {},
  });
  const steps = [
    {
      command: prebuild.command,
      args: prebuild.args,
      cwd: `${root}/${prebuild.cwd}`,
      env: prebuild.env,
    },
    {
      command: process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew',
      args: ['assembleRelease', '--console=plain'],
      cwd: `${root}/${prebuild.cwd}/android`,
      env: {
        APP_VARIANT: 'development',
        EXPO_TV: '1',
        ...(sdk === undefined ? {} : { ANDROID_HOME: sdk }),
      },
    },
  ];
  for (const step of steps) {
    const done = await exec(step.command, step.args, {
      cwd: step.cwd,
      env: step.env,
      timeoutMs: BUILD_TIMEOUT_MS,
    });
    if (!done.ok) {
      const tail = done.output.trim().split(/\r?\n/).slice(-5).join('\n');
      throw new Error(`gate: ${step.command} failed\n${tail}`);
    }
  }
}

/** A booted device and the two ways to talk to it. */
export interface AdbDevice {
  serial: string;
  dev: (...args: string[]) => Promise<ExecResult>;
  shell: (...args: string[]) => Promise<ExecResult>;
}

/** Finds the device (see {@link findDevice}) and checks that it finished booting. */
export async function openDevice(exec: Exec, adb: string, avd?: string): Promise<AdbDevice> {
  const serial = await findDevice(exec, adb, avd);
  const dev = (...args: string[]): Promise<ExecResult> =>
    adbCall(exec, adb, ['-s', serial, ...args]);
  const shell = (...args: string[]) => dev('shell', ...args);
  const booted = await shell('getprop', 'sys.boot_completed');
  if (booted.output.trim() !== '1') throw new Error(`gate: ${serial} has not finished booting`);
  return { serial, dev, shell };
}

/** Installs the release APK of the development variant; throws a one-line error when that fails. */
export async function installApk(
  exec: Exec,
  adb: string,
  serial: string,
  root: string,
): Promise<void> {
  const install = await adbCall(
    exec,
    adb,
    ['-s', serial, 'install', '-r', `${root}/${APK}`],
    INSTALL_TIMEOUT_MS,
  );
  if (!install.ok || !install.output.includes('Success')) {
    const reason = install.output.trim().split(/\r?\n/).pop() ?? '';
    throw new Error(`gate: adb install failed (${reason}); build the APK first with --build`);
  }
}

/**
 * Force-stops the app, clears logcat (and optionally the frame stats) and opens `url` in it. When another activity
 * holds the foreground it presses Back and retries once, then names the blocker.
 */
export async function startGate(
  device: AdbDevice,
  sleep: (ms: number) => Promise<void>,
  url: string,
  opts: { resetFrames?: boolean } = {},
): Promise<void> {
  const { dev, shell } = device;
  const launch = async () => {
    await shell('am', 'force-stop', APP_PACKAGE);
    await dev('logcat', '-c');
    if (opts.resetFrames === true) await shell('dumpsys', 'gfxinfo', APP_PACKAGE, 'reset');
    await shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${url}'`, APP_PACKAGE);
  };
  const foregroundBlocker = async (): Promise<string | undefined> => {
    let other: string | undefined;
    for (let i = 0; i < FOREGROUND_POLLS; i++) {
      other = topActivity((await shell('dumpsys', 'activity', 'activities')).output);
      if (other === undefined || other.startsWith(`${APP_PACKAGE}/`)) return undefined;
      await sleep(POLL_MS);
    }
    return other;
  };
  await launch();
  if ((await foregroundBlocker()) === undefined) return;
  await shell('input', 'keyevent', KEY_BACK);
  await sleep(POLL_MS);
  await launch();
  const again = await foregroundBlocker();
  if (again !== undefined) {
    throw new Error(
      `gate: ${again} holds the foreground, not the app; dismiss it on the device and rerun`,
    );
  }
}
