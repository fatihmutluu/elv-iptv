import { describe, expect, it } from 'vitest';
import { faultSpec, parseGateParams, resolveGate, streamUrl, vodUrl } from './params.ts';

const DEFAULTS = {
  base: 'http://127.0.0.1:7878',
  account: 'demo',
  channels: ['1001', '1002', '1003', '1004'],
  zaps: 30,
  rate: 0.5,
  vod: null,
  fault: '',
};

describe('parseGateParams', () => {
  it('returns undefined unless the query asks for the player gate', () => {
    expect(parseGateParams('')).toBeUndefined();
    expect(parseGateParams('?elv-gate=list')).toBeUndefined();
    expect(parseGateParams('account=demo')).toBeUndefined();
  });

  it('uses the defaults for a bare gate query', () => {
    expect(parseGateParams('elv-gate=player')).toEqual(DEFAULTS);
    expect(parseGateParams('?elv-gate=player')).toEqual(DEFAULTS);
  });

  it('reads every parameter', () => {
    const p = parseGateParams(
      'elv-gate=player&base=http://10.1.2.3:7880&account=big&channels=5,6,7&zaps=12&rate=1.5&vod=900&fault=notice',
    );
    expect(p).toEqual({
      base: 'http://10.1.2.3:7880',
      account: 'big',
      channels: ['5', '6', '7'],
      zaps: 12,
      rate: 1.5,
      vod: '900',
      fault: 'notice',
    });
  });

  it('clamps zaps to 1..200 and rate to 0.1..5', () => {
    expect(parseGateParams('elv-gate=player&zaps=0&rate=0')).toMatchObject({ zaps: 1, rate: 0.1 });
    expect(parseGateParams('elv-gate=player&zaps=9999&rate=50')).toMatchObject({
      zaps: 200,
      rate: 5,
    });
  });

  it('falls back on malformed numbers', () => {
    expect(parseGateParams('elv-gate=player&zaps=abc&rate=-1')).toMatchObject({
      zaps: 30,
      rate: 0.5,
    });
  });

  it('cuts the channel list at 20 and rejects non-numeric ids', () => {
    const many = Array.from({ length: 25 }, (_, i) => String(i + 1)).join(',');
    expect(parseGateParams(`elv-gate=player&channels=${many}`)?.channels).toHaveLength(20);
    expect(parseGateParams('elv-gate=player&channels=1,x')?.channels).toEqual(DEFAULTS.channels);
    expect(parseGateParams('elv-gate=player&channels=')?.channels).toEqual(DEFAULTS.channels);
  });

  it.each([
    'http://127.0.0.1:7878',
    'http://localhost:7880',
    'http://10.0.0.5:80',
    'http://192.168.1.20:7878',
    'http://172.16.0.1:7878',
    'http://172.31.255.1:7878',
    'http://127.0.0.1',
  ])('accepts the base %s', (base) => {
    expect(parseGateParams(`elv-gate=player&base=${base}`)?.base).toBe(base);
  });

  it.each([
    'https://127.0.0.1:7878',
    'http://example.com:7878',
    'http://8.8.8.8:80',
    'http://172.32.0.1:7878',
    'http://127.0.0.1:99999',
    'http://127.0.0.1:7878/live',
    'http://user:pw@127.0.0.1:7878',
    'http://127.0.0.1.evil.com:7878',
    'ftp://127.0.0.1',
    'javascript:alert(1)',
  ])('replaces the base %s with the default', (base) => {
    expect(parseGateParams(`elv-gate=player&base=${base}`)?.base).toBe(DEFAULTS.base);
  });

  it('accepts a percent-encoded base', () => {
    expect(parseGateParams('elv-gate=player&base=http%3A%2F%2F127.0.0.1%3A7880')?.base).toBe(
      'http://127.0.0.1:7880',
    );
  });

  it('accepts only the known faults', () => {
    for (const fault of ['drop5', '404', '509', 'notice', 'stall', 'slowstart']) {
      expect(parseGateParams(`elv-gate=player&fault=${fault}`)?.fault).toBe(fault);
    }
    expect(parseGateParams('elv-gate=player&fault=boom')?.fault).toBe('');
  });

  it('accepts only a numeric vod id and a plain account name', () => {
    expect(parseGateParams('elv-gate=player&vod=12x')?.vod).toBeNull();
    expect(parseGateParams('elv-gate=player&account=a/b')?.account).toBe('demo');
  });
});

describe('stream urls', () => {
  const params = parseGateParams(
    'elv-gate=player&base=http://127.0.0.1:7880&account=demo&channels=1001,1002&vod=900&fault=drop5',
  );

  it('builds live urls at play time, with the fault on the first channel only', () => {
    expect(params && streamUrl(params, 0)).toBe(
      'http://127.0.0.1:7880/live/demo/demo/1001.ts?fault=drop@5s',
    );
    expect(params && streamUrl(params, 1)).toBe('http://127.0.0.1:7880/live/demo/demo/1002.ts');
  });

  it('builds the vod url without a fault', () => {
    expect(params && vodUrl(params)).toBe('http://127.0.0.1:7880/movie/demo/demo/900.mp4');
  });

  it('maps the faults to simulator specs', () => {
    expect(faultSpec('')).toBeUndefined();
    expect(faultSpec('404')).toBe('status=404');
    expect(faultSpec('509')).toBe('status=509');
    expect(faultSpec('notice')).toBe('text-notice');
    expect(faultSpec('stall')).toBe('stall30s@2s');
    expect(faultSpec('slowstart')).toBe('slow-start=3');
  });
});

describe('resolveGate', () => {
  const search = '?elv-gate=player&zaps=3';
  it('parses the gate only when the preload says main is in gate mode', () => {
    expect(resolveGate(search, { gate: true })?.zaps).toBe(3);
    expect(resolveGate(search, { gate: false })).toBeUndefined();
    expect(resolveGate(search, {})).toBeUndefined();
    expect(resolveGate(search, undefined)).toBeUndefined();
  });
  it('is undefined for a normal query in gate mode', () => {
    expect(resolveGate('', { gate: true })).toBeUndefined();
  });
});
