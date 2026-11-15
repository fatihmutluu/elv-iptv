import { describe, expect, it } from 'vitest';
import { CONTRACT_USAGE, contractMain } from '../src/gates/contract-cli.ts';
import {
  type ContractLine,
  judgeContract,
  parseContractLine,
  runContractGate,
} from '../src/gates/contract-gate.ts';
import type { GateDevice } from '../src/gates/gate-device.ts';

const logLine = (body: unknown) =>
  `2026-11-15 10:00:05.000 Df ELVIPTV[42:1] ELV_GATE_CONTRACT ${JSON.stringify(body)}`;

function fakeDevice(opts: { logs: string[]; simHost?: string; crashes?: string[] }): {
  device: GateDevice;
  events: string[];
  urls: string[];
} {
  const events: string[] = [];
  const urls: string[] = [];
  let reads = 0;
  const device: GateDevice = {
    simHost: opts.simHost ?? '127.0.0.1:7878',
    describe: async () => ({ platform: 'tvos', name: 'Apple TV 4K (3rd generation)' }),
    install: async () => void events.push('install'),
    start: async (url, startOpts) => {
      events.push('start');
      await startOpts?.afterStop?.();
      urls.push(url);
    },
    stop: async () => void events.push('stop'),
    readLog: async () => opts.logs[Math.min(reads++, opts.logs.length - 1)] ?? '',
    crashesSince: async () => opts.crashes ?? [],
    memoryMb: async () => null,
    close: async () => void events.push('close'),
  };
  return { device, events, urls };
}

describe('parseContractLine', () => {
  it('parses the last well-formed ELV_GATE_CONTRACT line and ignores malformed ones', () => {
    const first: ContractLine = { passed: 7, failed: [{ name: 'a', message: 'boom' }] };
    const second: ContractLine = { passed: 8, failed: [] };
    const text = ['noise', logLine(first), 'ELV_GATE_CONTRACT {bad', logLine(second)].join('\n');
    expect(parseContractLine(text)).toEqual(second);
    expect(parseContractLine('ELV_GATE_CONTRACT {"passed":"8","failed":[]}')).toBeUndefined();
    expect(parseContractLine('ELV_GATE_CONTRACT {"passed":1,"failed":[{}]}')).toBeUndefined();
    expect(parseContractLine('nothing')).toBeUndefined();
  });
});

describe('judgeContract', () => {
  it('passes when cases passed with no failures and no crashes, and names every failure', () => {
    expect(judgeContract({ passed: 8, failed: [] }, [])).toEqual({ ok: true, failures: [] });
    expect(
      judgeContract(
        {
          passed: 6,
          failed: [
            { name: 'notFound', message: 'expected http-404' },
            { name: 'zap', message: '2 open medias' },
          ],
        },
        ['ELVIPTV-1.ips'],
      ),
    ).toEqual({
      ok: false,
      failures: [
        'notFound: expected http-404',
        'zap: 2 open medias',
        'crash reports newer than the run: ELVIPTV-1.ips',
      ],
    });
    expect(judgeContract({ passed: 0, failed: [] }, [])).toEqual({
      ok: false,
      failures: ['contract: 0 cases ran'],
    });
  });
});

describe('runContractGate', () => {
  it("opens the contract route with the device's simHost, reuses a running simulator without FFmpeg and closes", async () => {
    const dev = fakeDevice({
      logs: ['', logLine({ passed: 8, failed: [] })],
    });
    const simEvents: string[] = [];
    const out = await runContractGate({
      exec: async () => ({ ok: true, output: '' }),
      device: dev.device,
      sim: {
        ensure: async () => ({
          reused: true,
          stop: async () => void simEvents.push('sim-stop'),
        }),
      },
      ffmpeg: () => null,
      sleep: async () => {},
    });
    expect(dev.urls).toEqual(['elviptv://gate/contract?host=127.0.0.1:7878&account=demo']);
    expect(dev.events).toEqual(['install', 'start', 'stop', 'close']);
    expect(simEvents).toEqual(['sim-stop']);
    expect(out.outcome).toEqual({ ok: true, failures: [] });
    expect(out.line.passed).toBe(8);
  });

  it('fails on failed contract cases or a crash report', async () => {
    const dev = fakeDevice({
      logs: [logLine({ passed: 7, failed: [{ name: 'oneConnection', message: 'overlap' }] })],
      crashes: ['ELVIPTV-crash.ips'],
    });
    const out = await runContractGate({
      exec: async () => ({ ok: true, output: '' }),
      device: dev.device,
      sim: { ensure: async () => ({ reused: true, stop: async () => {} }) },
      ffmpeg: () => null,
      sleep: async () => {},
    });
    expect(out.outcome.ok).toBe(false);
    expect(out.outcome.failures).toEqual([
      'oneConnection: overlap',
      'crash reports newer than the run: ELVIPTV-crash.ips',
    ]);
  });

  it('times out after 180 s when no line appears and still closes the device', async () => {
    const dev = fakeDevice({ logs: [''] });
    await expect(
      runContractGate({
        exec: async () => ({ ok: true, output: '' }),
        device: dev.device,
        sim: { ensure: async () => ({ reused: true, stop: async () => {} }) },
        ffmpeg: () => null,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/no ELV_GATE_CONTRACT line within 180 s/);
    expect(dev.events.at(-1)).toBe('close');
  });
});

describe('contractMain', () => {
  it('requires --app on Apple targets before touching a device', async () => {
    const err: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((t: string) => {
      err.push(t);
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await contractMain({ target: 'tvos' }, '.')).toBe(2);
    } finally {
      process.stderr.write = real;
    }
    expect(err.join('')).toMatch(/--app/);
    expect(CONTRACT_USAGE).toMatch(/gate contract.*--target/);
  });
});
