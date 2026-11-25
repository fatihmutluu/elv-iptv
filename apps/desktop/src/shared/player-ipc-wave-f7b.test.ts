import { describe, expect, it } from 'vitest';
import { DESKTOP_CAPABILITIES, isPlayerCommandMessage } from './player-ipc.ts';
import { hasValidWaveF7bLoadOptions, isProgramId } from './player-ipc-wave-f7b.ts';

const baseLoad = {
  attempt: 1,
  url: 'https://sim.example.test/live/demo/mux.ts',
  headers: {},
  kind: 'live',
};

const msg = (command: unknown) => ({ engineId: 'engine-1', command });

describe('Wave F7B player IPC guards (#304)', () => {
  it('enables programSelection capability on desktop', () => {
    expect(DESKTOP_CAPABILITIES.programSelection).toBe(true);
  });

  it('accepts valid numeric and alphanumeric program IDs and rejects invalid values', () => {
    for (const valid of ['0', '1', '101', '65535', 'prog_1', 'service-2', 'A'.repeat(32)]) {
      expect(isProgramId(valid)).toBe(true);
    }

    for (const invalid of [
      '',
      ' ',
      '   ',
      '-1',
      '_leading',
      '-leading',
      '101\n',
      '101\r',
      '101;drop',
      '101,vid=1',
      '101=2',
      'prog 1',
      'a/b',
      'a'.repeat(33),
      null,
      undefined,
      101,
      {},
    ]) {
      expect(isProgramId(invalid)).toBe(false);
    }
  });

  it('accepts valid selectProgram commands and rejects malformed, extra-key, or prototype-polluted commands', () => {
    expect(isPlayerCommandMessage(msg({ name: 'selectProgram', attempt: 2, id: '101' }))).toBe(
      true,
    );
    expect(isPlayerCommandMessage(msg({ name: 'selectProgram', attempt: 0, id: '0' }))).toBe(true);
    expect(isPlayerCommandMessage(msg({ name: 'selectProgram', attempt: 5, id: 'svc_202' }))).toBe(
      true,
    );

    const polluted = JSON.parse(
      '{"name":"selectProgram","attempt":2,"id":"101","__proto__":{"polluted":true}}',
    );
    const bad: unknown[] = [
      { name: 'selectProgram' },
      { name: 'selectProgram', attempt: 1 },
      { name: 'selectProgram', attempt: -1, id: '101' },
      { name: 'selectProgram', attempt: '1', id: '101' },
      { name: 'selectProgram', attempt: 1, id: null },
      { name: 'selectProgram', attempt: 1, id: '' },
      { name: 'selectProgram', attempt: 1, id: 101 },
      { name: 'selectProgram', attempt: 1, id: '101\n' },
      { name: 'selectProgram', attempt: 1, id: '101', extra: true },
      polluted,
    ];
    for (const command of bad) {
      expect(isPlayerCommandMessage(msg(command))).toBe(false);
    }
  });

  it('validates optional programId on LoadCommand.options', () => {
    expect(hasValidWaveF7bLoadOptions({})).toBe(true);
    expect(hasValidWaveF7bLoadOptions({ programId: '202' })).toBe(true);
    expect(hasValidWaveF7bLoadOptions({ programId: '' })).toBe(false);
    expect(hasValidWaveF7bLoadOptions({ programId: 202 })).toBe(false);

    expect(
      isPlayerCommandMessage(
        msg({
          name: 'load',
          cmd: { ...baseLoad, options: { programId: '202' } },
        }),
      ),
    ).toBe(true);

    expect(
      isPlayerCommandMessage(
        msg({
          name: 'load',
          cmd: { ...baseLoad, options: { programId: 'bad;cmd' } },
        }),
      ),
    ).toBe(false);
  });
});
