import { describe, expect, it } from 'vitest';
import { HOST_SAMPLE, RuleBook } from './m3u-rules';

const ACCT = ['acct', 'token', '0123456789'].join('');
const OTHER = ['acct', 'token', '9876543210'].join('');
const urls = (host: string, token: string, n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `https://${host}/${token}/s${from + i}`);

describe('RuleBook', () => {
  it('settles hosts of the sample with enough URLs and holds the others', () => {
    const book = new RuleBook();
    book.start([...urls('big.example', ACCT, HOST_SAMPLE), ...urls('small.example', ACCT, 3)]);
    expect(book.rules).toEqual([{ host: 'big.example', position: 0, name: 'v0' }]);
    expect(book.hold('https://big.example/x/y')).toBe(false);
    expect(book.hold('https://small.example/a/b')).toBe(true);
    expect(book.hold('not a url')).toBe(false);
    expect(book.ready).toBe(false);
  });

  it('judges a held host once it collected enough URLs', () => {
    const book = new RuleBook();
    book.start([]);
    for (const url of urls('late.example', ACCT, HOST_SAMPLE + 5)) book.hold(url);
    expect(book.ready).toBe(true);
    book.settle();
    expect(book.rules).toEqual([{ host: 'late.example', position: 0, name: 'v0' }]);
    expect(book.hold('https://late.example/a/b')).toBe(false);
  });

  it('keeps stored names, numbers new pairs after them and replaces stored rules on judgement', () => {
    const book = new RuleBook([
      { host: 'a.example', position: 0, name: 'v3' },
      { host: 'a.example', position: 1, name: 'v4' },
      { host: 'gone.example', position: 0, name: 'v1' },
    ]);
    book.start([...urls('a.example', ACCT, HOST_SAMPLE), ...urls('b.example', ACCT, HOST_SAMPLE)]);
    expect(book.rules).toEqual([
      { host: 'a.example', position: 0, name: 'v3' },
      { host: 'gone.example', position: 0, name: 'v1' },
      { host: 'b.example', position: 0, name: 'v5' },
    ]);
    expect(book.final()).toEqual([]);
    book.hold('https://a.example/x/y');
    book.hold('https://b.example/x/y');
    expect(book.final().map((r) => r.host)).toEqual(['a.example', 'b.example']);
  });

  it('keeps stored rules of a host judged on a single URL', () => {
    const book = new RuleBook([{ host: 'one.example', position: 0, name: 'v0' }]);
    book.start([]);
    book.hold(`https://one.example/${ACCT}/s1`);
    book.settle();
    expect(book.final()).toEqual([{ host: 'one.example', position: 0, name: 'v0' }]);
  });

  it('drops a stored rule that the new judgement no longer confirms', () => {
    const book = new RuleBook();
    book.start([]);
    for (const url of urls('h.example', ACCT, 10)) book.hold(url);
    book.settle();
    expect(book.rules).toHaveLength(1);
    const again = new RuleBook(book.rules);
    again.start([]);
    for (const url of urls('h.example', OTHER, 5)) again.hold(url);
    for (const url of urls('h.example', ACCT, 5)) again.hold(url);
    again.settle();
    expect(again.rules).toEqual([]);
  });
});
