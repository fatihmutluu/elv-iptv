import { describe, expect, it } from 'vitest';
import { parseGateUrl } from '../routes';

describe('parseGateUrl', () => {
  it('returns undefined for null and for other URLs', () => {
    expect(parseGateUrl(null)).toBeUndefined();
    expect(parseGateUrl('')).toBeUndefined();
    expect(parseGateUrl('https://gate/list')).toBeUndefined();
    expect(parseGateUrl('elviptv://other/list')).toBeUndefined();
    expect(parseGateUrl('elviptv://gate/detail')).toBeUndefined();
  });

  it('applies the defaults', () => {
    expect(parseGateUrl('elviptv://gate/list')).toEqual({
      items: 100_000,
      auto: false,
      rate: 20,
      moves: 600,
    });
  });

  it('reads every parameter', () => {
    expect(parseGateUrl('elviptv://gate/list?items=5000&auto=1&rate=30&moves=100')).toEqual({
      items: 5000,
      auto: true,
      rate: 30,
      moves: 100,
    });
  });

  it('accepts a trailing slash and ignores unknown parameters', () => {
    expect(parseGateUrl('elviptv://gate/list/?foo=1&items=10')).toMatchObject({ items: 10 });
  });

  it('bounds the values and falls back on garbage', () => {
    expect(parseGateUrl('elviptv://gate/list?items=99999999')?.items).toBe(1_000_000);
    expect(parseGateUrl('elviptv://gate/list?items=0')?.items).toBe(1);
    expect(parseGateUrl('elviptv://gate/list?rate=0')?.rate).toBe(1);
    expect(parseGateUrl('elviptv://gate/list?rate=500')?.rate).toBe(60);
    expect(parseGateUrl('elviptv://gate/list?moves=0')?.moves).toBe(1);
    expect(parseGateUrl('elviptv://gate/list?moves=99999999')?.moves).toBe(10_000);
    expect(parseGateUrl('elviptv://gate/list?items=abc&rate=x&moves=')).toMatchObject({
      items: 100_000,
      rate: 20,
      moves: 600,
    });
    expect(parseGateUrl('elviptv://gate/list?auto=0')?.auto).toBe(false);
  });
});
