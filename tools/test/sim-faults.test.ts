import { afterEach, describe, expect, it } from 'vitest';
import { FaultParseError, mediaType, parseFaults } from '../src/sim/faults.ts';
import { liveArgs } from '../src/sim/media.ts';
import { type SimHandle, startSim } from '../src/sim/server.ts';

describe('parseFaults', () => {
  it('parses each fault', () => {
    expect(parseFaults('status=403')).toEqual([{ kind: 'status', code: 403 }]);
    expect(parseFaults('drop@10s')).toEqual([{ kind: 'drop', atSec: 10 }]);
    expect(parseFaults('stall5s@8s')).toEqual([{ kind: 'stall', forSec: 5, atSec: 8 }]);
    expect(parseFaults('slow-start=3')).toEqual([{ kind: 'slow-start', sec: 3 }]);
    expect(parseFaults('redirect')).toEqual([{ kind: 'redirect' }]);
    expect(parseFaults('text-notice')).toEqual([{ kind: 'text-notice' }]);
    expect(parseFaults('rate=256')).toEqual([{ kind: 'rate', kbps: 256 }]);
    expect(parseFaults('status=509,drop@2s')).toEqual([
      { kind: 'status', code: 509 },
      { kind: 'drop', atSec: 2 },
    ]);
  });

  it('treats an empty spec as no faults', () => {
    expect(parseFaults('')).toEqual([]);
  });

  it('rejects unknown faults', () => {
    expect(() => parseFaults('explode')).toThrow(FaultParseError);
    expect(() => parseFaults('explode')).toThrow(/explode/);
    expect(() => parseFaults('status=abc')).toThrow(/status=abc/);
    expect(() => parseFaults('status=200,')).toThrow(FaultParseError);
    expect(() => parseFaults('status=99')).toThrow(FaultParseError);
    expect(() => parseFaults('status=100')).toThrow(FaultParseError);
    expect(() => parseFaults('status=600')).toThrow(FaultParseError);
  });

  it('parses delivery quirks', () => {
    expect(parseFaults('type=text/html')).toEqual([{ kind: 'type', mime: 'text/html' }]);
    expect(parseFaults('type=application/octet-stream,redirect=hls')).toEqual([
      { kind: 'type', mime: 'application/octet-stream' },
      { kind: 'redirect-hls' },
    ]);
    for (const bad of ['type=html', 'type=text/html;charset=x', 'redirect=dash', 'type='])
      expect(() => parseFaults(bad)).toThrow(bad);
    expect(mediaType(parseFaults('drop@1s,type=text/html'), 'video/mp2t')).toBe('text/html');
    expect(mediaType([], 'video/mp2t')).toBe('video/mp2t');
  });

  it('parses an empty 200 response', () => {
    expect(parseFaults('empty')).toEqual([{ kind: 'empty' }]);
    expect(parseFaults('type=video/mp4,empty')).toEqual([
      { kind: 'type', mime: 'video/mp4' },
      { kind: 'empty' },
    ]);
    expect(() => parseFaults('empty=1')).toThrow(FaultParseError);
  });

  it('parses a provider burst of up to 30 s', () => {
    expect(parseFaults('burst=8')).toEqual([{ kind: 'burst', sec: 8 }]);
    expect(parseFaults('burst=0.5')).toEqual([{ kind: 'burst', sec: 0.5 }]);
    expect(parseFaults('burst=30')).toEqual([{ kind: 'burst', sec: 30 }]);
    expect(parseFaults('drop@5s,burst=8')).toEqual([
      { kind: 'drop', atSec: 5 },
      { kind: 'burst', sec: 8 },
    ]);
    for (const bad of ['burst=0', 'burst=31', 'burst=30.5', 'burst=x', 'burst=', 'burst=-1'])
      expect(() => parseFaults(bad)).toThrow(FaultParseError);
  });
});

describe('empty request fault', () => {
  const open: SimHandle[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close()));
  });

  async function sim(): Promise<SimHandle> {
    const handle = await startSim({ port: 0, ffmpegPath: null });
    open.push(handle);
    return handle;
  }

  it('answers 200 with an empty body and keeps the media content type of the path', async () => {
    const { url } = await sim();
    const res = await fetch(`${url}/movie/demo/demo/1.mp4?fault=empty`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('0');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    const mkv = await fetch(`${url}/movie/demo/demo/2.mkv?fault=empty`);
    expect(mkv.headers.get('content-type')).toBe('video/x-matroska');
    await mkv.arrayBuffer();
    const ts = await fetch(`${url}/live/demo/demo/1001.ts?fault=empty`);
    expect(ts.headers.get('content-type')).toBe('video/mp2t');
    await ts.arrayBuffer();
    const shortTs = await fetch(`${url}/demo/demo/1001?fault=empty`);
    expect(shortTs.headers.get('content-type')).toBe('video/mp2t');
    await shortTs.arrayBuffer();
    const hls = await fetch(`${url}/live/demo/demo/1010.m3u8?fault=empty`);
    expect(hls.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    await hls.arrayBuffer();
  });

  it('answers text/plain on non-media paths', async () => {
    const { url } = await sim();
    const res = await fetch(`${url}/player_api.php?fault=empty`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('lets a type fault override the media content type', async () => {
    const { url } = await sim();
    const res = await fetch(`${url}/movie/demo/demo/1.mp4?fault=type=text/html,empty`);
    expect(res.headers.get('content-type')).toBe('text/html');
    await res.arrayBuffer();
  });

  it('keeps the content type a type fault asks for', async () => {
    const { url } = await sim();
    const res = await fetch(`${url}/movie/demo/demo/1.mp4?fault=type=video/mp4,empty`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe('0');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });
});

describe('liveArgs', () => {
  it('reads in real time without a burst', () => {
    const args = liveArgs('loop.ts');
    expect(args).toContain('-re');
    expect(args).not.toContain('-readrate');
    expect(args).not.toContain('-readrate_initial_burst');
    expect(args.indexOf('-re')).toBeLessThan(args.indexOf('-i'));
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', 'loop.ts']);
    expect(args.at(-1)).toBe('pipe:1');
  });

  it('replaces -re with an initial burst', () => {
    const args = liveArgs('loop.ts', 8);
    expect(args).not.toContain('-re');
    const at = args.indexOf('-readrate');
    expect(args.slice(at, at + 4)).toEqual(['-readrate', '1', '-readrate_initial_burst', '8']);
    expect(at).toBeLessThan(args.indexOf('-i'));
    expect(args.at(-1)).toBe('pipe:1');
  });

  it('treats a zero burst as none', () => {
    expect(liveArgs('loop.ts', 0)).toEqual(liveArgs('loop.ts'));
  });
});
