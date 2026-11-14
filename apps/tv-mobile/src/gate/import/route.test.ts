import { describe, expect, it } from 'vitest';
import { parseImportUrl } from './route';

describe('parseImportUrl', () => {
  it('returns undefined for anything but elviptv://gate/import', () => {
    expect(parseImportUrl(null)).toBeUndefined();
    expect(parseImportUrl('')).toBeUndefined();
    expect(parseImportUrl('elviptv://gate/list')).toBeUndefined();
    expect(parseImportUrl('https://gate/import')).toBeUndefined();
  });

  it('applies the defaults', () => {
    expect(parseImportUrl('elviptv://gate/import')).toEqual({
      host: '10.0.2.2:7878',
      account: 'large',
      batch: 1000,
      maxBody: 4096,
      series: false,
      probeReads: false,
    });
  });

  it('reads every parameter', () => {
    expect(
      parseImportUrl(
        'elviptv://gate/import?host=127.0.0.1:9000&account=huge&batch=5000&maxBody=1024',
      ),
    ).toEqual({
      host: '127.0.0.1:9000',
      account: 'huge',
      batch: 5000,
      maxBody: 1024,
      series: false,
      probeReads: false,
    });
  });

  it('turns the series and reader probes on with 1 only', () => {
    expect(parseImportUrl('elviptv://gate/import?series=1&probeReads=1')).toMatchObject({
      series: true,
      probeReads: true,
    });
    expect(parseImportUrl('elviptv://gate/import?series=true&probeReads=0')).toMatchObject({
      series: false,
      probeReads: false,
    });
  });

  it('accepts a trailing slash and ignores unknown parameters', () => {
    expect(parseImportUrl('elviptv://gate/import/?foo=1&batch=700')).toMatchObject({ batch: 700 });
  });

  it('clamps the batch to 500..20000 and falls back on garbage', () => {
    expect(parseImportUrl('elviptv://gate/import?batch=10')?.batch).toBe(500);
    expect(parseImportUrl('elviptv://gate/import?batch=99999')?.batch).toBe(20_000);
    expect(parseImportUrl('elviptv://gate/import?batch=x')?.batch).toBe(1000);
    expect(parseImportUrl('elviptv://gate/import?batch=')?.batch).toBe(1000);
  });

  it('clamps maxBody to 256..131072 KiB and falls back on garbage', () => {
    expect(parseImportUrl('elviptv://gate/import?maxBody=1')?.maxBody).toBe(256);
    expect(parseImportUrl('elviptv://gate/import?maxBody=999999')?.maxBody).toBe(131_072);
    expect(parseImportUrl('elviptv://gate/import?maxBody=x')?.maxBody).toBe(4096);
  });

  it('accepts only the known accounts', () => {
    expect(parseImportUrl('elviptv://gate/import?account=demo')?.account).toBe('large');
    expect(parseImportUrl('elviptv://gate/import?account=huge')?.account).toBe('huge');
  });

  it('accepts only the development hosts', () => {
    for (const host of ['10.0.2.2:7878', '127.0.0.1:1', 'localhost:8080', '10.0.2.2']) {
      expect(parseImportUrl(`elviptv://gate/import?host=${host}`)?.host).toBe(host);
    }
    for (const host of ['example.com', '192.168.1.5:7878', '10.0.2.2:99999999', 'a/b@10.0.2.2']) {
      expect(parseImportUrl(`elviptv://gate/import?host=${host}`)?.host).toBe('10.0.2.2:7878');
    }
  });
});
