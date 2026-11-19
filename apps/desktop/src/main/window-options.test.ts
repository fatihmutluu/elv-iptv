import { describe, expect, it } from 'vitest';
import { attachRendererCrashRecovery, buildWindowOptions } from './window-options.ts';

describe('buildWindowOptions', () => {
  const options = buildWindowOptions('/app/dist/preload/preload.js');

  it('enables the renderer security baseline', () => {
    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });

  it('loads the given preload script', () => {
    expect(options.webPreferences?.preload).toBe('/app/dist/preload/preload.js');
  });

  it('titles the window ELV IPTV', () => {
    expect(options.title).toBe('ELV IPTV');
  });
});

describe('buildWindowOptions player baseline', () => {
  const options = buildWindowOptions('/app/dist/preload/preload.js');

  it('backgroundThrottling is false and the security baseline holds', () => {
    expect(options.webPreferences).toEqual({
      preload: '/app/dist/preload/preload.js',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    });
  });
});

describe('buildWindowOptions gate mode', () => {
  it('tells the preload only when main started in gate mode', () => {
    expect(buildWindowOptions('/p.js').webPreferences?.additionalArguments).toBeUndefined();
    expect(
      buildWindowOptions('/p.js', { gate: false }).webPreferences?.additionalArguments,
    ).toBeUndefined();
    expect(buildWindowOptions('/p.js', { gate: true }).webPreferences?.additionalArguments).toEqual(
      ['--elv-gate-mode'],
    );
  });
});

describe('attachRendererCrashRecovery (#257)', () => {
  function fakeRecoverableWindow() {
    let listener: ((event: unknown, details: { reason: string }) => void) | undefined;
    let destroyed = false;
    const reloads: string[] = [];
    const logs: string[] = [];
    return {
      target: {
        isDestroyed: () => destroyed,
        loadURL: (url: string) => {
          reloads.push(url);
          return Promise.resolve();
        },
        webContents: {
          isDestroyed: () => destroyed,
          on: (_ev: 'render-process-gone', l: (e: unknown, d: { reason: string }) => void) => {
            listener = l;
          },
        },
      },
      crash: (reason = 'crashed') => listener?.({}, { reason }),
      destroy: () => {
        destroyed = true;
      },
      reloads,
      logs,
    };
  }

  it('reloads non-clean renderer crashes up to maxReloads and stops on crash loops', () => {
    const f = fakeRecoverableWindow();
    let clock = 1000;
    attachRendererCrashRecovery(f.target, {
      gate: false,
      reloadUrl: 'app://elv/',
      now: () => clock,
      log: (line) => f.logs.push(line),
    });

    f.crash('clean-exit');
    expect(f.reloads).toEqual([]);

    f.crash('crashed');
    clock += 1000;
    f.crash('oom');
    clock += 1000;
    f.crash('killed');
    clock += 1000;
    f.crash('crashed');
    expect(f.reloads).toEqual(['app://elv/', 'app://elv/', 'app://elv/']);
    expect(f.logs).toHaveLength(1);

    // After the 60s window expires, recovery budget resets:
    clock += 61_000;
    f.crash('crashed');
    expect(f.reloads).toHaveLength(4);

    f.destroy();
    f.crash('crashed');
    expect(f.reloads).toHaveLength(4);
  });

  it('does not attach recovery reload in gate mode', () => {
    const f = fakeRecoverableWindow();
    attachRendererCrashRecovery(f.target, {
      gate: true,
      reloadUrl: 'app://elv/?elv-gate=player',
    });
    f.crash('crashed');
    expect(f.reloads).toEqual([]);
  });
});
