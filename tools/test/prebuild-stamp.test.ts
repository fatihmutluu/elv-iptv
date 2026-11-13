import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type PrebuildStamp,
  parseStamp,
  planPrebuild,
  readStamp,
  STAMP_FILE,
  writeStamp,
} from '../src/prebuild-stamp.ts';

const want: PrebuildStamp = { target: 'android-tv', variant: 'development', store: 'default' };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'elv_stamp_'));
  dirs.push(d);
  return d;
};

describe('planPrebuild', () => {
  it('cleans when the native project has no stamp', () => {
    expect(planPrebuild(want, null)).toEqual({ clean: true, stamp: want });
  });

  it('reuses a native project made for the same target, variant and store', () => {
    expect(planPrebuild(want, { ...want })).toEqual({ clean: false, stamp: want });
  });

  it.each([{ target: 'android' }, { variant: 'production' }, { store: 'amazon' }])(
    'cleans when the stamp differs in %j',
    (change) => {
      expect(planPrebuild(want, { ...want, ...change })).toEqual({ clean: true, stamp: want });
    },
  );
});

describe('parseStamp', () => {
  it('reads a stamp written by writeStamp', () => {
    expect(parseStamp(JSON.stringify(want))).toEqual(want);
  });

  it.each([
    ['malformed JSON', '{'],
    ['a missing field', JSON.stringify({ target: 'android', variant: 'development' })],
    ['a non-string field', JSON.stringify({ ...want, store: 1 })],
    ['an array', '[]'],
    ['null', 'null'],
  ])('returns null for %s', (_, content) => {
    expect(parseStamp(content)).toBeNull();
  });
});

describe('readStamp and writeStamp', () => {
  it('round-trips a stamp through the stamp file', () => {
    const dir = tempDir();
    writeStamp(join(dir, STAMP_FILE), want);
    expect(readStamp(join(dir, STAMP_FILE))).toEqual(want);
  });

  it('returns null when the file is missing or not a stamp', () => {
    const dir = tempDir();
    expect(readStamp(join(dir, STAMP_FILE))).toBeNull();
    writeFileSync(join(dir, STAMP_FILE), 'not json');
    expect(readStamp(join(dir, STAMP_FILE))).toBeNull();
  });
});
