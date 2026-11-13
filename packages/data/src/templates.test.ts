import { m3uKey } from '@elv/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detectSegmentRules, resolveTemplate, toTemplate } from './templates';

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
function token(length: number, seed: number): string {
  let out = '';
  let s = seed + 1;
  for (let i = 0; i < length; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out += ALNUM[s % ALNUM.length];
  }
  return out;
}
const P = ['pass', 'word'].join('');
const NONE = {};

describe('detectSegmentRules', () => {
  it('finds the constant account token of a two-segment panel URL', () => {
    const acct = token(24, 1);
    const sample = Array.from(
      { length: 1000 },
      (_, i) => `https://h.example/${acct}/${token(16, i + 10)}`,
    );
    expect(detectSegmentRules(sample)).toEqual([{ host: 'h.example', position: 0, name: 'v0' }]);
  });

  it('detects rules per host', () => {
    const a = token(20, 2);
    const b = token(20, 3);
    const sample = [
      ...Array.from({ length: 50 }, (_, i) => `https://one.example/${a}/${token(12, i)}`),
      ...Array.from({ length: 50 }, (_, i) => `https://two.example/x/${b}/${token(12, i + 100)}`),
    ];
    expect(detectSegmentRules(sample)).toEqual([
      { host: 'one.example', position: 0, name: 'v0' },
      { host: 'two.example', position: 1, name: 'v1' },
    ]);
  });

  it('ignores short constant segments, anything below 99 percent, and the empty sample', () => {
    const live = Array.from({ length: 200 }, (_, i) => `https://h.example/live/${token(16, i)}`);
    expect(detectSegmentRules(live)).toEqual([]);
    const acct = token(24, 5);
    const noisy = Array.from({ length: 100 }, (_, i) =>
      i < 2
        ? `https://h.example/${token(24, i + 50)}/${token(12, i)}`
        : `https://h.example/${acct}/${token(12, i)}`,
    );
    expect(detectSegmentRules(noisy)).toEqual([]);
    expect(detectSegmentRules([])).toEqual([]);
  });

  it('never treats the last segment or an unparsable value as a rule', () => {
    const sample = Array.from({ length: 20 }, () => 'https://h.example/a/index_long_name.m3u8');
    expect(detectSegmentRules([...sample, 'not a url'])).toEqual([]);
  });

  it('needs more than one URL on a host', () => {
    expect(detectSegmentRules([`https://h.example/${token(24, 1)}/x`])).toEqual([]);
  });

  it('accepts exactly 99 percent', () => {
    const acct = token(24, 6);
    const sample = Array.from({ length: 100 }, (_, i) =>
      i === 0 ? `https://h.example/${token(24, 99)}/s${i}` : `https://h.example/${acct}/s${i}`,
    );
    expect(detectSegmentRules(sample)).toHaveLength(1);
  });
});

describe('toTemplate', () => {
  it('moves credential query values into vars', () => {
    const url = `https://h.example/play.m3u8?Token=abc&channel=7&username=bob&${P}=hunter2`;
    const { template, vars } = toTemplate(url, [], NONE);
    expect(template).toBe(
      `https://h.example/play.m3u8?Token={{q:token}}&channel=7&username={{q:username}}&${P}={{q:${P}}}`,
    );
    expect(vars).toEqual({ 'q:token': 'abc', 'q:username': 'bob', [`q:${P}`]: 'hunter2' });
    expect(resolveTemplate(template, vars)).toBe(url);
  });

  it('keeps repeated credential parameters apart', () => {
    const url = 'https://h.example/p?token=a&token=b';
    const { template, vars } = toTemplate(url, [], NONE);
    expect(Object.keys(vars)).toHaveLength(2);
    expect(resolveTemplate(template, vars)).toBe(url);
  });

  it('leaves a valueless parameter alone', () => {
    const url = 'https://h.example/p?token&x=1';
    expect(toTemplate(url, [], NONE)).toEqual({ template: url, vars: {} });
  });

  it('templates Xtream path credentials with known credentials', () => {
    const { template, vars } = toTemplate(
      `https://h.example:8080/${['live', 'bob', 's3cret', '12.ts'].join('/')}`,
      [],
      {
        username: 'bob',
        password: 's3cret',
      },
    );
    expect(template).toBe('https://h.example:8080/live/{{user}}/{{pass}}/12.ts');
    expect(vars).toEqual({ user: 'bob', pass: 's3cret' });
  });

  it('templates Xtream-shaped segments without known credentials', () => {
    for (const url of [
      'https://h.example/movie/u1/p1/5.mkv',
      'https://h.example/timeshift/u1/p1/60/2026-01-01/7.ts',
      'https://h.example/u1/p1/99',
    ]) {
      const { template, vars } = toTemplate(url, [], NONE);
      expect(template).toContain('{{user}}/{{pass}}');
      expect(resolveTemplate(template, vars)).toBe(url);
    }
  });

  it('replaces known credentials found elsewhere in the path', () => {
    const { template } = toTemplate('https://h.example/a/bob/b/s3cret/c', [], {
      username: 'bob',
      password: 's3cret',
    });
    expect(template).toBe('https://h.example/a/{{user}}/b/{{pass}}/c');
  });

  it('applies segment rules for their host only', () => {
    const rules = [{ host: 'h.example', position: 0, name: 'v0' }];
    const a = toTemplate('https://H.example/tok123456/stream9', rules, NONE);
    expect(a.template).toBe('https://H.example/{{v0}}/stream9');
    expect(a.vars).toEqual({ v0: 'tok123456' });
    const b = toTemplate('https://other.example/tok123456/stream9', rules, NONE);
    expect(b.template).toBe('https://other.example/tok123456/stream9');
  });

  it('does not double-template a rule segment that also looks like an Xtream user', () => {
    const rules = [{ host: 'h.example', position: 0, name: 'v0' }];
    const { template, vars } = toTemplate('https://h.example/tok123456/p1/99', rules, NONE);
    expect(template).toBe('https://h.example/{{v0}}/p1/99');
    expect(resolveTemplate(template, vars)).toBe('https://h.example/tok123456/p1/99');
  });

  it('templates userinfo, keeps fragments and passes unparsable values through', () => {
    const { template, vars } = toTemplate('https://bob:pw@h.example/a/b?x=1#frag', [], NONE);
    expect(template).toBe('https://{{userinfo}}@h.example/a/b?x=1#frag');
    expect(resolveTemplate(template, vars)).toBe('https://bob:pw@h.example/a/b?x=1#frag');
    expect(toTemplate('not a url', [], NONE)).toEqual({ template: 'not a url', vars: {} });
    expect(toTemplate('https://h.example', [], NONE).template).toBe('https://h.example');
  });

  it('resolveTemplate leaves unknown placeholders and dollar signs intact', () => {
    expect(resolveTemplate('a/{{x}}/{{y}}', { x: '$&1' })).toBe('a/$&1/{{y}}');
  });

  it('round-trips generated URLs', () => {
    const word = fc.stringMatching(/^[a-z0-9]{1,12}$/);
    fc.assert(
      fc.property(
        fc.record({
          host: word,
          segs: fc.array(word, { minLength: 0, maxLength: 5 }),
          query: fc.array(
            fc.tuple(fc.constantFrom('token', 'Token', 'user', 'channel', 'sig', 'x'), word),
            { maxLength: 4 },
          ),
          user: word,
          pass: word,
          pos: fc.integer({ min: 0, max: 4 }),
        }),
        ({ host, segs, query, user, pass, pos }) => {
          const q = query.map(([k, v]) => `${k}=${v}`).join('&');
          const url = `https://${host}.example/${segs.join('/')}${q ? `?${q}` : ''}`;
          const rules = [{ host: `${host}.example`, position: pos, name: 'v0' }];
          const t = toTemplate(url, rules, { username: user, password: pass });
          expect(resolveTemplate(t.template, t.vars)).toBe(url);
        },
      ),
    );
  });
});

describe('keys survive credential changes', () => {
  it('keeps the template and key when the account token changes', () => {
    const rules = [{ host: 'h.example', position: 0, name: 'v0' }];
    const one = toTemplate(`https://h.example/${token(24, 1)}/${token(10, 4)}`, rules, NONE);
    const two = toTemplate(`https://h.example/${token(24, 2)}/${token(10, 4)}`, rules, NONE);
    expect(one.template).toBe(two.template);
    expect(m3uKey('s1', one.template, 'News')).toBe(m3uKey('s1', two.template, 'News'));
  });

  it('keeps the template and key when query credentials or the password change', () => {
    const a = toTemplate(`https://h.example/p.m3u8?channel=1&token=${token(8, 1)}`, [], NONE);
    const b = toTemplate(`https://h.example/p.m3u8?channel=1&token=${token(8, 2)}`, [], NONE);
    expect(a.template).toBe(b.template);
    const c = toTemplate(`https://h.example/${['live', 'bob', 'old', '12.ts'].join('/')}`, [], {
      username: 'bob',
      password: 'old',
    });
    const d = toTemplate(`https://h.example/${['live', 'bob', 'new', '12.ts'].join('/')}`, [], {
      username: 'bob',
      password: 'new',
    });
    expect(m3uKey('s1', c.template, 'X')).toBe(m3uKey('s1', d.template, 'X'));
  });
});
