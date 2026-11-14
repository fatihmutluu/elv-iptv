import { describe, expect, it } from 'vitest';
import { headerOptions, LAUNCH_OPTIONS, launchArgs, loadfileCommand } from './options.ts';

describe('launchArgs', () => {
  it('launch args keep the exact fixed options and never contain a url', () => {
    const args = launchArgs({
      inputConf: 'C:\\r\\mpv-input.conf',
      presenterArgs: ['--wid=42'],
      transportArgs: [
        '--input-ipc-server=\\\\.\\pipe\\elv-mpv-0123456789abcdef',
        '--elv-parent-pid=7',
      ],
    });
    expect(args.slice(0, LAUNCH_OPTIONS.length)).toEqual([...LAUNCH_OPTIONS]);
    expect(LAUNCH_OPTIONS).toEqual([
      '--no-config',
      '--idle=yes',
      '--force-window=immediate',
      '--keep-open=no',
      '--ytdl=no',
      '--load-scripts=no',
      '--save-position-on-quit=no',
      '--resume-playback=no',
      '--terminal=no',
      '--title=ELV IPTV',
      '--hwdec=auto-safe',
      '--network-timeout=10',
      '--curl-enabled=no',
      '--script-opts=osc-idlescreen=no',
    ]);
    expect(args.slice(LAUNCH_OPTIONS.length)).toEqual([
      '--input-conf=C:\\r\\mpv-input.conf',
      '--wid=42',
      '--input-ipc-server=\\\\.\\pipe\\elv-mpv-0123456789abcdef',
      '--elv-parent-pid=7',
    ]);
    expect(args.join(' ')).not.toMatch(/https?:/);
  });
});

describe('headerOptions', () => {
  it('user-agent uses its own option', () => {
    expect(headerOptions({ 'User-Agent': 'VLC/3' })).toEqual({ 'user-agent': 'VLC/3' });
  });
  it('referer maps to referrer', () => {
    expect(headerOptions({ Referer: 'http://r/' })).toEqual({ referrer: 'http://r/' });
    expect(headerOptions({ referrer: 'http://r/' })).toEqual({ referrer: 'http://r/' });
  });
  it('escapes only commas in http-header-fields and leaves backslashes alone', () => {
    expect(headerOptions({ 'X-A': 'a,b', 'X-B': 'c\\d' })).toEqual({
      'http-header-fields': 'X-A: a\\,b,X-B: c\\d',
    });
  });
  it('returns nothing for no headers', () => {
    expect(headerOptions({})).toEqual({});
  });
});

describe('loadfileCommand', () => {
  const base = { url: 'http://h/1.ts', headers: {} };
  it('loadfile uses replace, index -1 and string option values', () => {
    const cmd = loadfileCommand({ ...base, kind: 'live' });
    expect(cmd.slice(0, 4)).toEqual(['loadfile', 'http://h/1.ts', 'replace', -1]);
    const opts = cmd[4] as Record<string, string>;
    expect(Object.values(opts).every((v) => typeof v === 'string')).toBe(true);
  });
  it('startMs 12345 becomes start=12.345', () => {
    const opts = loadfileCommand({ ...base, kind: 'vod', startMs: 12345 })[4] as Record<
      string,
      string
    >;
    expect(opts['start']).toBe('12.345');
  });
  it('omits start when absent', () => {
    expect(loadfileCommand({ ...base, kind: 'vod' })[4]).not.toHaveProperty('start');
  });
  it('live and vod get their cache limits', () => {
    expect(loadfileCommand({ ...base, kind: 'live' })[4]).toEqual({
      'demuxer-max-bytes': '32MiB',
      'demuxer-max-back-bytes': '0',
    });
    expect(loadfileCommand({ ...base, kind: 'vod', headers: { 'User-Agent': 'u' } })[4]).toEqual({
      'user-agent': 'u',
      'demuxer-max-bytes': '64MiB',
      'demuxer-max-back-bytes': '16MiB',
    });
  });
});
