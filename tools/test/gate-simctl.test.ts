import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Exec } from '../src/gates/adb.ts';
import { appleSimDevice } from '../src/gates/simctl.ts';

const APP = '/tmp/Build/Products/Release-appletvsimulator/ELVIPTV.app';
const BUNDLE = 'io.github.fatihmutluu.elviptv.dev';
const EXEC_NAME = 'ELVIPTV';

function devicesJson(devices: Record<string, unknown[]>) {
  return JSON.stringify({ devices });
}

interface Call {
  command: string;
  args: string[];
  timeoutMs: number | undefined;
}

function fakeExec(opts: {
  devices?: Record<string, unknown[]>;
  createdUdid?: string;
  launchctl?: string;
  rss?: string;
  log?: string;
  hangOn?: string;
  terminateOk?: boolean;
}) {
  const calls: Call[] = [];
  const events: string[] = [];
  const exec: Exec = async (command, args, callOpts) => {
    calls.push({ command, args, timeoutMs: callOpts?.timeoutMs });
    const line = `${command} ${args.join(' ')}`;
    if (opts.hangOn !== undefined && line.includes(opts.hangOn)) {
      return { ok: false, timedOut: true, output: `${command}: timed out` };
    }
    if (command === '/usr/libexec/PlistBuddy') {
      const key = args[1] ?? '';
      if (key.includes('CFBundleIdentifier')) return { ok: true, output: `${BUNDLE}\n` };
      if (key.includes('CFBundleExecutable')) return { ok: true, output: `${EXEC_NAME}\n` };
    }
    if (args[0] === 'simctl' && args[1] === 'list') {
      return {
        ok: true,
        output: devicesJson(
          opts.devices ?? {
            'com.apple.CoreSimulator.SimRuntime.tvOS-26-4': [
              {
                udid: 'UDID-NEW',
                name: 'Apple TV 4K (3rd generation)',
                state: 'Shutdown',
                isAvailable: true,
              },
            ],
          },
        ),
      };
    }
    if (args[0] === 'simctl' && args[1] === 'create') {
      events.push(`create:${args.slice(2).join(':')}`);
      return { ok: true, output: `${opts.createdUdid ?? 'UDID-CREATED'}\n` };
    }
    if (args[0] === 'simctl' && args[1] === 'bootstatus') {
      events.push(`bootstatus:${args[2]}`);
      return { ok: true, output: '' };
    }
    if (args[0] === 'simctl' && args[1] === 'install') {
      events.push(`install:${args[2]}:${args[3]}`);
      return { ok: true, output: '' };
    }
    if (args[0] === 'simctl' && args[1] === 'terminate') {
      events.push(`terminate:${args[2]}:${args[3]}`);
      return { ok: opts.terminateOk ?? false, output: 'found nothing to terminate' };
    }
    if (args[0] === 'simctl' && args[1] === 'launch') {
      events.push(`launch:${args.slice(2).join(' ')}`);
      return { ok: true, output: `${BUNDLE}: 4242\n` };
    }
    if (args[0] === 'simctl' && args[1] === 'spawn' && args[3] === 'log') {
      return { ok: true, output: opts.log ?? 'ELV_GATE_PLAYER {}\n' };
    }
    if (args[0] === 'simctl' && args[1] === 'spawn' && args[3] === 'launchctl') {
      return {
        ok: true,
        output:
          opts.launchctl ??
          `PID\tStatus\tLabel\n-\t0\tcom.apple.other\n4242\t0\tUIKitApplication:${BUNDLE}[0x1a2b][rb-legacy]\n`,
      };
    }
    if (args[0] === 'simctl' && args[1] === 'shutdown') {
      events.push(`shutdown:${args[2]}`);
      return { ok: true, output: '' };
    }
    if (command === 'ps') {
      return { ok: true, output: opts.rss ?? ' 204800\n' };
    }
    return { ok: true, output: '' };
  };
  return { exec, calls, events };
}

describe('appleSimDevice', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('picks the named device on the newest tvOS runtime', async () => {
    const f = fakeExec({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
          { udid: 'IOS', name: 'Apple TV 4K (3rd generation)', state: 'Booted', isAvailable: true },
        ],
        'com.apple.CoreSimulator.SimRuntime.tvOS-18-2': [
          {
            udid: 'TV-OLD',
            name: 'Apple TV 4K (3rd generation)',
            state: 'Booted',
            isAvailable: true,
          },
        ],
        'com.apple.CoreSimulator.SimRuntime.tvOS-26-4': [
          { udid: 'OTHER', name: 'Apple TV', state: 'Shutdown', isAvailable: true },
          {
            udid: 'TV-26',
            name: 'Apple TV 4K (3rd generation)',
            state: 'Shutdown',
            isAvailable: true,
          },
        ],
      },
    });
    const dev = await appleSimDevice(f.exec, { platform: 'tvos', app: APP });
    expect(dev.simHost).toBe('127.0.0.1:7878');
    expect(await dev.describe()).toEqual({
      platform: 'tvos',
      name: 'Apple TV 4K (3rd generation)',
      runtime: 'tvOS-26-4',
      udid: 'TV-26',
    });
    await dev.install();
    expect(f.events).toEqual(['bootstatus:TV-26', `install:TV-26:${APP}`]);
    await dev.close();
    expect(f.events.at(-1)).toBe('shutdown:TV-26');
  });

  it('leaves an already-booted simulator running on close', async () => {
    const f = fakeExec({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [
          { udid: 'IPHONE', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true },
        ],
      },
    });
    const dev = await appleSimDevice(f.exec, { platform: 'ios', app: APP });
    await dev.close();
    expect(f.events).toEqual(['bootstatus:IPHONE']);
  });

  it('creates a device when none exists', async () => {
    const f = fakeExec({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.tvOS-26-4': [],
      },
      createdUdid: 'NEW-UDID',
    });
    const dev = await appleSimDevice(f.exec, { platform: 'tvos', app: APP });
    expect(f.events).toEqual([
      'create:elv-gate-tvos:Apple TV 4K (3rd generation):com.apple.CoreSimulator.SimRuntime.tvOS-26-4',
      'bootstatus:NEW-UDID',
    ]);
    expect((await dev.describe()).udid).toBe('NEW-UDID');
    await dev.close();
    expect(f.events.at(-1)).toBe('shutdown:NEW-UDID');
  });

  it('start terminates, runs afterStop, then launches with -gateUrl', async () => {
    const f = fakeExec({});
    const dev = await appleSimDevice(f.exec, { platform: 'tvos', app: APP });
    f.events.length = 0;
    const url = 'elviptv://gate/player?host=127.0.0.1:7878&zaps=4';
    await dev.start(url, {
      afterStop: async () => {
        f.events.push('afterStop');
      },
    });
    expect(f.events).toEqual([
      `terminate:UDID-NEW:${BUNDLE}`,
      'afterStop',
      `launch:UDID-NEW ${BUNDLE} -gateUrl ${url}`,
    ]);
  });

  it('readLog asks for the log since the launch', async () => {
    let clock = Date.parse('2026-11-15T08:30:45.678Z');
    const f = fakeExec({ log: 'line-after-launch\n' });
    const dev = await appleSimDevice(f.exec, {
      platform: 'tvos',
      app: APP,
      now: () => clock,
    });
    await dev.start('elviptv://gate/contract?host=127.0.0.1:7878');
    clock += 5000;
    expect(await dev.readLog()).toBe('line-after-launch\n');
    const logCall = f.calls.find((c) => c.args[3] === 'log');
    expect(logCall?.args).toEqual([
      'simctl',
      'spawn',
      'UDID-NEW',
      'log',
      'show',
      '--style',
      'compact',
      '--start',
      '2026-11-15 08:30:45+0000',
      '--predicate',
      'eventMessage CONTAINS "ELV_GATE"',
    ]);
  });

  it("crashesSince keeps the app's reports newer than the time", async () => {
    const reportsDir = mkdtempSync(join(tmpdir(), 'elv-crashes-'));
    dirs.push(reportsDir);
    const t0 = Date.parse('2026-11-15T10:00:00.000Z');
    const touch = (name: string, epochMs: number) => {
      const p = join(reportsDir, name);
      writeFileSync(p, '{}');
      const sec = epochMs / 1000;
      utimesSync(p, sec, sec);
    };
    touch(`${EXEC_NAME}-2026-11-15-095959.ips`, t0 - 2000);
    touch(`${EXEC_NAME}-2026-11-15-100005.ips`, t0 + 5000);
    touch('OtherApp-2026-11-15-100006.ips', t0 + 6000);
    touch(`${EXEC_NAME}-notes.txt`, t0 + 6000);

    const f = fakeExec({});
    const dev = await appleSimDevice(f.exec, { platform: 'tvos', app: APP, reportsDir });
    expect(await dev.crashesSince(t0)).toEqual([`${EXEC_NAME}-2026-11-15-100005.ips`]);
  });

  it('reads resident memory in MB from launchctl and ps, or null when not running', async () => {
    const f = fakeExec({ rss: ' 204800\n' });
    const dev = await appleSimDevice(f.exec, { platform: 'tvos', app: APP });
    expect(await dev.memoryMb()).toBe(200);

    const idle = fakeExec({ launchctl: `PID\tStatus\tLabel\n-\t0\tUIKitApplication:${BUNDLE}\n` });
    const stoppedDev = await appleSimDevice(idle.exec, { platform: 'tvos', app: APP });
    expect(await stoppedDev.memoryMb()).toBeNull();
  });

  it('a hung xcrun call throws a one-line timeout', async () => {
    const f = fakeExec({ hangOn: 'xcrun simctl bootstatus' });
    let caught: Error | undefined;
    try {
      await appleSimDevice(f.exec, { platform: 'tvos', app: APP });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/^gate: xcrun simctl bootstatus UDID-NEW -b timed out after /);
    expect(caught?.message).not.toContain('\n');
    expect(f.calls.every((c) => (c.timeoutMs ?? 0) > 0)).toBe(true);
  });
});
