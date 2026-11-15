import { describe, expect, it } from 'vitest';
import { faultSpec, type PlayerStream, parsePlayerGateUrl, streamUrl } from '../player-routes';

const BASE = 'elviptv://gate/player';

describe('parsePlayerGateUrl', () => {
  it('ignores other links', () => {
    expect(parsePlayerGateUrl(null)).toBeUndefined();
    expect(parsePlayerGateUrl('elviptv://gate/list')).toBeUndefined();
    expect(parsePlayerGateUrl('elviptv://gate/players')).toBeUndefined();
  });

  it('uses the defaults for a bare link', () => {
    expect(parsePlayerGateUrl(BASE)).toEqual({
      host: '10.0.2.2:7878',
      account: 'demo',
      channels: ['1001', '1002', '1003', '1004'],
      zaps: 30,
      rate: 0.5,
      fault: '',
      stream: 'ts',
    });
    expect(parsePlayerGateUrl(`${BASE}/?#x`)?.zaps).toBe(30);
  });

  it('reads every parameter', () => {
    const url = `${BASE}?host=127.0.0.1:9000&account=large&channels=7,8&zaps=5&rate=1.5&fault=drop5&stream=hls`;
    expect(parsePlayerGateUrl(url)).toEqual({
      host: '127.0.0.1:9000',
      account: 'large',
      channels: ['7', '8'],
      zaps: 5,
      rate: 1.5,
      fault: 'drop5',
      stream: 'hls',
    });
  });

  it('clamps zaps and rate', () => {
    expect(parsePlayerGateUrl(`${BASE}?zaps=0&rate=0.01`)).toMatchObject({ zaps: 1, rate: 0.05 });
    expect(parsePlayerGateUrl(`${BASE}?zaps=1&rate=0.05`)).toMatchObject({ zaps: 1, rate: 0.05 });
    expect(parsePlayerGateUrl(`${BASE}?zaps=9999&rate=99`)).toMatchObject({ zaps: 200, rate: 5 });
  });

  it('falls back on malformed numbers', () => {
    expect(parsePlayerGateUrl(`${BASE}?zaps=x&rate=fast`)).toMatchObject({ zaps: 30, rate: 0.5 });
    expect(parsePlayerGateUrl(`${BASE}?zaps=-3&rate=-1`)).toMatchObject({ zaps: 30, rate: 0.5 });
  });

  it('cuts the channel list at 20 and rejects non-numeric ids', () => {
    const many = Array.from({ length: 25 }, (_, i) => String(i + 1)).join(',');
    expect(parsePlayerGateUrl(`${BASE}?channels=${many}`)?.channels).toHaveLength(20);
    expect(parsePlayerGateUrl(`${BASE}?channels=1,../2`)?.channels).toEqual([
      '1001',
      '1002',
      '1003',
      '1004',
    ]);
    expect(parsePlayerGateUrl(`${BASE}?channels=`)?.channels).toHaveLength(4);
  });

  it('replaces hosts outside the development hosts and bad ports', () => {
    expect(parsePlayerGateUrl(`${BASE}?host=evil.example.com`)?.host).toBe('10.0.2.2:7878');
    expect(parsePlayerGateUrl(`${BASE}?host=localhost:99999`)?.host).toBe('10.0.2.2:7878');
    expect(parsePlayerGateUrl(`${BASE}?host=localhost`)?.host).toBe('localhost');
  });

  it('accepts only known faults and plain account names', () => {
    expect(parsePlayerGateUrl(`${BASE}?fault=404`)?.fault).toBe('404');
    expect(parsePlayerGateUrl(`${BASE}?fault=509`)?.fault).toBe('509');
    expect(parsePlayerGateUrl(`${BASE}?fault=notice`)?.fault).toBe('notice');
    expect(parsePlayerGateUrl(`${BASE}?fault=stall`)?.fault).toBe('stall');
    expect(parsePlayerGateUrl(`${BASE}?fault=silent`)?.fault).toBe('silent');
    expect(parsePlayerGateUrl(`${BASE}?fault=slowstart`)?.fault).toBe('slowstart');
    expect(parsePlayerGateUrl(`${BASE}?fault=status=500`)?.fault).toBe('');
    expect(parsePlayerGateUrl(`${BASE}?account=a/b`)?.account).toBe('demo');
  });

  it('accepts only known stream forms', () => {
    const forms: PlayerStream[] = ['ts', 'hls', 'vod'];
    for (const form of forms) {
      expect(parsePlayerGateUrl(`${BASE}?stream=${form}`)?.stream).toBe(form);
    }
    expect(parsePlayerGateUrl(`${BASE}?stream=mkv`)?.stream).toBe('ts');
  });
});

describe('streamUrl', () => {
  const params = parsePlayerGateUrl(`${BASE}?channels=1001,1002&fault=drop5`);
  if (params === undefined) throw new Error('route');

  it('builds simulator URLs and faults only the first channel', () => {
    expect(streamUrl(params, 0)).toBe('http://10.0.2.2:7878/live/demo/demo/1001.ts?fault=drop@5s');
    expect(streamUrl(params, 1)).toBe('http://10.0.2.2:7878/live/demo/demo/1002.ts');
  });

  it('maps every fault to the simulator grammar', () => {
    expect(faultSpec('')).toBeUndefined();
    expect(faultSpec('404')).toBe('status=404');
    expect(faultSpec('509')).toBe('status=509');
    expect(faultSpec('notice')).toBe('text-notice');
    expect(faultSpec('stall')).toBe('stall30s@2s');
    expect(faultSpec('silent')).toBe('stall30s@0s');
    expect(faultSpec('slowstart')).toBe('slow-start=3');
  });

  it('builds HLS and movie URLs for the other stream forms', () => {
    const hls = { ...params, fault: 'notice' as const, stream: 'hls' as const };
    expect(streamUrl(hls, 0)).toBe(
      'http://10.0.2.2:7878/live/demo/demo/1001.m3u8?fault=text-notice',
    );
    const vod = { ...params, channels: ['200001'], fault: '' as const, stream: 'vod' as const };
    expect(streamUrl(vod, 0)).toBe('http://10.0.2.2:7878/movie/demo/demo/200001.mp4');
  });
});
