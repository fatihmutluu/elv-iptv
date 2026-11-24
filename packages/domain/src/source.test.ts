import { describe, expect, it } from 'vitest';
import { isValidMacAddress, normalizeMacAddress, type SourceKind, transportHeaders } from './index';

describe('Stalker MAC address validation and normalization (#29)', () => {
  it('normalizes valid colon-separated MAC addresses to uppercase', () => {
    expect(normalizeMacAddress('00:1a:79:ab:cd:ef')).toEqual({
      ok: true,
      value: '00:1A:79:AB:CD:EF',
    });
    expect(normalizeMacAddress('AA:BB:CC:DD:EE:FF')).toEqual({
      ok: true,
      value: 'AA:BB:CC:DD:EE:FF',
    });
    expect(normalizeMacAddress('  00:1A:79:aB:Cd:09  ')).toEqual({
      ok: true,
      value: '00:1A:79:AB:CD:09',
    });
  });

  it('normalizes valid hyphen-separated MAC addresses to colon-separated uppercase', () => {
    expect(normalizeMacAddress('00-1a-79-ab-cd-ef')).toEqual({
      ok: true,
      value: '00:1A:79:AB:CD:EF',
    });
    expect(normalizeMacAddress('AA-BB-CC-DD-EE-FF')).toEqual({
      ok: true,
      value: 'AA:BB:CC:DD:EE:FF',
    });
    expect(normalizeMacAddress('\t00-1A-79-00-00-01\t')).toEqual({
      ok: true,
      value: '00:1A:79:00:00:01',
    });
  });

  it('rejects non-string inputs with source-format/invalid-mac', () => {
    for (const invalid of [null, undefined, 123456, true, false, {}, []]) {
      const result = normalizeMacAddress(invalid);
      expect(result.ok, `expected rejection for ${String(invalid)}`).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe('source-format');
        expect(result.error.code).toBe('invalid-mac');
      }
      expect(isValidMacAddress(invalid)).toBe(false);
    }
  });

  it('rejects invalid length, mixed or unsupported separators, non-hex, and control chars', () => {
    const invalidCases = [
      '',
      '   ',
      '00:1A:79:01:02',
      '00:1A:79:01:02:03:04',
      '001A79010203',
      '00:1A-79:01:02:03',
      '00-1A:79-01-02-03',
      '00.1A.79.01.02.03',
      '00 1A 79 01 02 03',
      '00:1G:79:01:02:03',
      'ZZ:BB:CC:DD:EE:FF',
      '00:1A:79:01:02:0\n',
      '00:1A\x00:79:01:02:03',
      '00:1A:79:01:02:\r3',
      '0:1A:79:01:02:030',
    ];

    for (const raw of invalidCases) {
      const result = normalizeMacAddress(raw);
      expect(result.ok, `expected rejection for ${JSON.stringify(raw)}`).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe('source-format');
        expect(result.error.code).toBe('invalid-mac');
      }
      expect(isValidMacAddress(raw)).toBe(false);
    }
  });

  it('exposes isValidMacAddress and stalker SourceKind', () => {
    const kind: SourceKind = 'stalker';
    expect(kind).toBe('stalker');
    expect(isValidMacAddress('00:1a:79:00:00:01')).toBe(true);
    expect(isValidMacAddress('00-1a-79-00-00-01')).toBe(true);
    expect(isValidMacAddress('not-a-mac')).toBe(false);
    expect(
      transportHeaders({ userAgent: 'ELV/1.0', referer: 'http://portal.example.test/' }),
    ).toEqual({
      'user-agent': 'ELV/1.0',
      referer: 'http://portal.example.test/',
    });
  });
});
