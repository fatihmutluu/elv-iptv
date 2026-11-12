import { describe, expect, it } from 'vitest';
import { checkFileSizes } from '../src/file-size.ts';

const lines = (n: number, eol = '\n') => `${Array(n).fill('x').join(eol)}${eol}`;

describe('checkFileSizes', () => {
  it('accepts files at the soft limit', () => {
    expect(checkFileSizes({ 'a.ts': lines(400) })).toEqual({ warnings: [], errors: [] });
  });

  it('warns above 400 lines and errors above 800', () => {
    const r = checkFileSizes({ 'a.ts': lines(401), 'b.tsx': lines(801) });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('a.ts');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('b.tsx');
  });

  it('counts CRLF files the same as LF files', () => {
    expect(checkFileSizes({ 'a.ts': lines(400, '\r\n') }).warnings).toEqual([]);
    expect(checkFileSizes({ 'a.ts': lines(401, '\r\n') }).warnings).toHaveLength(1);
  });

  it('only checks ts, tsx, mjs and cjs files', () => {
    const r = checkFileSizes({
      'a.json': lines(900),
      'b.md': lines(900),
      'c.mjs': lines(900),
      'd.cjs': lines(401),
    });
    expect(r.errors).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
  });

  it('skips generated and vendored paths', () => {
    const big = lines(900);
    const r = checkFileSizes({
      'node_modules/x/a.ts': big,
      'apps/tv-mobile/android/a.ts': big,
      'apps/tv-mobile/.expo/types.ts': big,
      'packages/i18n/src/locales/en.generated.ts': big,
      'packages/x/dist/a.ts': big,
      'packages/x/src/generated/api.ts': big,
    });
    expect(r).toEqual({ warnings: [], errors: [] });
  });

  it('normalizes Windows separators when skipping', () => {
    expect(checkFileSizes({ 'node_modules\\x\\a.ts': lines(900) }).errors).toEqual([]);
  });

  it('honors custom limits', () => {
    const r = checkFileSizes({ 'a.ts': lines(11) }, { soft: 5, hard: 10 });
    expect(r.errors).toHaveLength(1);
  });
});
