import { describe, expect, it } from 'vitest';
import { FaultParseError, parseFaults } from '../src/sim/faults.ts';

describe('parseFaults', () => {
  it('parses each fault', () => {
    expect(parseFaults('status=403')).toEqual([{ kind: 'status', code: 403 }]);
    expect(parseFaults('drop@10s')).toEqual([{ kind: 'drop', atSec: 10 }]);
    expect(parseFaults('stall5s@8s')).toEqual([{ kind: 'stall', forSec: 5, atSec: 8 }]);
    expect(parseFaults('slow-start=3')).toEqual([{ kind: 'slow-start', sec: 3 }]);
    expect(parseFaults('redirect')).toEqual([{ kind: 'redirect' }]);
    expect(parseFaults('text-notice')).toEqual([{ kind: 'text-notice' }]);
    expect(parseFaults('rate=256')).toEqual([{ kind: 'rate', kbps: 256 }]);
    expect(parseFaults('status=509,drop@2s')).toEqual([
      { kind: 'status', code: 509 },
      { kind: 'drop', atSec: 2 },
    ]);
  });

  it('treats an empty spec as no faults', () => {
    expect(parseFaults('')).toEqual([]);
  });

  it('rejects unknown faults', () => {
    expect(() => parseFaults('explode')).toThrow(FaultParseError);
    expect(() => parseFaults('explode')).toThrow(/explode/);
    expect(() => parseFaults('status=abc')).toThrow(/status=abc/);
    expect(() => parseFaults('status=200,')).toThrow(FaultParseError);
    expect(() => parseFaults('status=99')).toThrow(FaultParseError);
    expect(() => parseFaults('status=100')).toThrow(FaultParseError);
    expect(() => parseFaults('status=600')).toThrow(FaultParseError);
  });
});
