import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseXmltvTime } from './xmltv-time';

const T = Date.UTC(2026, 0, 1);

describe('parseXmltvTime', () => {
  it('applies the offset', () => {
    expect(parseXmltvTime('20260101000000 +0000')).toBe(T);
    expect(parseXmltvTime('20260101030000 +0300')).toBe(T);
    expect(parseXmltvTime('20251231190000 -0500')).toBe(T);
    expect(parseXmltvTime('20260101010000+0100')).toBe(T);
    expect(parseXmltvTime('20260101030000 +03:00')).toBe(T);
    expect(parseXmltvTime('20260101030000 +03')).toBe(T);
    expect(parseXmltvTime('20260101000000Z')).toBe(T);
  });

  it('accepts shorter forms as UTC', () => {
    expect(parseXmltvTime('202601010000')).toBe(T);
    expect(parseXmltvTime('2026010100')).toBe(T);
    expect(parseXmltvTime('20260101')).toBe(T);
    expect(parseXmltvTime('202601')).toBe(T);
    expect(parseXmltvTime('2026')).toBe(T);
    expect(parseXmltvTime('  20260101000000  ')).toBe(T);
  });

  it('rejects invalid input', () => {
    for (const bad of [
      '',
      '2026010100000',
      '20261301000000',
      '20260001000000',
      '20260230000000',
      '20260132000000',
      '20260101240000',
      '20260101006000',
      '20260101000060',
      '20260101000000 0100',
      '20260101000000 +01x0',
      '20260101000000 +2460',
      '20260101000000 +1',
      '202x0101000000',
      '0099010100',
      'abc',
    ]) {
      expect(parseXmltvTime(bad), bad).toBeUndefined();
    }
  });

  it('knows leap days', () => {
    expect(parseXmltvTime('20240229000000')).toBe(Date.UTC(2024, 1, 29));
    expect(parseXmltvTime('20250229000000')).toBeUndefined();
    expect(parseXmltvTime('21000229000000')).toBeUndefined();
    expect(parseXmltvTime('20000229000000')).toBe(Date.UTC(2000, 1, 29));
  });

  it('round-trips generated instants and offsets', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2090, 0, 1) }),
        fc.integer({ min: -23 * 60, max: 23 * 60 }),
        (ms, off) => {
          const s = Math.floor(ms / 1000) * 1000;
          const d = new Date(s + off * 60_000);
          const p = (n: number, w = 2) => String(n).padStart(w, '0');
          const a = Math.abs(off);
          const text = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} ${off < 0 ? '-' : '+'}${p(Math.floor(a / 60))}${p(a % 60)}`;
          expect(parseXmltvTime(text)).toBe(s);
        },
      ),
    );
  });
});
