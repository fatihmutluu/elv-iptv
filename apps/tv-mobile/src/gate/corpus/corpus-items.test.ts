import { describe, expect, it } from 'vitest';
import { buildCorpusItems, parseCorpusGateUrl } from './corpus-items';

describe('parseCorpusGateUrl', () => {
  it('parses elviptv://gate/corpus links and falls back on malformed values', () => {
    expect(parseCorpusGateUrl(null)).toBeUndefined();
    expect(parseCorpusGateUrl('elviptv://gate/player')).toBeUndefined();
    expect(parseCorpusGateUrl('elviptv://gate/corpus')).toEqual({
      host: '10.0.2.2:7878',
      account: 'corpus',
      burst: 0,
    });
    expect(
      parseCorpusGateUrl('elviptv://gate/corpus?host=127.0.0.1:7878&account=demo&burst=8'),
    ).toEqual({
      host: '127.0.0.1:7878',
      account: 'demo',
      burst: 8,
    });
    expect(
      parseCorpusGateUrl('elviptv://gate/corpus?host=evil.example:7878&account=a/b&burst=99'),
    ).toEqual({
      host: '10.0.2.2:7878',
      account: 'corpus',
      burst: 30,
    });
    expect(parseCorpusGateUrl('elviptv://gate/corpus?host=127.0.0.1:70000&burst=abc')).toEqual({
      host: '10.0.2.2:7878',
      account: 'corpus',
      burst: 0,
    });
  });
});

describe('buildCorpusItems', () => {
  it('builds the 29-item manifest with and without a burst', () => {
    const plain = buildCorpusItems({ base: 'http://127.0.0.1:7878', account: 'demo' });
    expect(plain).toHaveLength(29);
    expect(plain[0]?.url).toBe('http://127.0.0.1:7878/live/demo/demo/1001.ts');
    expect(plain[11]?.url).toBe('http://127.0.0.1:7878/live/demo/demo/1012.ts');
    expect(plain[12]?.url).toBe('http://127.0.0.1:7878/demo/demo/1013');
    expect(plain[13]?.url).toBe('http://127.0.0.1:7878/live/demo/demo/1014.ts');

    const burst = buildCorpusItems({ base: 'http://127.0.0.1:7878', account: 'demo', burst: 8 });
    expect(burst[0]?.url).toBe('http://127.0.0.1:7878/live/demo/demo/1001.ts?fault=burst=8');
    expect(burst[11]?.url).toBe(
      'http://127.0.0.1:7878/live/demo/demo/1012.ts?fault=type=text/html,burst=8',
    );
    expect(burst[13]?.url).toBe(
      'http://127.0.0.1:7878/live/demo/demo/1014.ts?fault=type=application/vnd.apple.mpegurl,burst=8',
    );
  });
});
