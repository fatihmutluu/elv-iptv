import { describe, expect, it } from 'vitest';
import {
  headerFields,
  headerOptions,
  LAUNCH_OPTIONS,
  launchArgs,
  loadfileCommand,
} from './options.ts';

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
      '--load-unsafe-playlists=no',
      '--save-position-on-quit=no',
      '--resume-playback=no',
      '--terminal=no',
      '--title=ELV IPTV',
      '--audio-client-name=ELV IPTV',
      '--hwdec=auto-safe',
      '--audio-fallback-to-null=yes',
      '--demuxer-mkv-probe-start-time=no',
      '--demuxer-lavf-probe-info=yes',
      '--cache-on-disk=no',
      '--demuxer-donate-buffer=no',
      '--autoload-files=no',
      '--prefetch-playlist=no',
      '--audio-pitch-correction=yes',
      '--tls-verify=yes',
      '--stream-lavf-o=icy=0,reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5',
      '--reset-on-next-file=aid,sid,secondary-sid,secondary-sub-pos,vid,program,sub-visibility,audio-delay,sub-delay,video-aspect-override,deinterlace,speed,panscan,keepaspect,video-unscaled,gamma,brightness,contrast,saturation',
      '--network-timeout=10',
      '--curl-enabled=no',
      '--osc=no',
      '--osd-level=0',
      '--input-default-bindings=no',
    ]);
    expect(LAUNCH_OPTIONS).not.toContain('--script-opts=osc-idlescreen=no');
    expect(LAUNCH_OPTIONS).not.toContain('--input-vo-keyboard=no');
    expect(LAUNCH_OPTIONS.some((o) => o.startsWith('--tls-ca-file'))).toBe(false);
    expect(LAUNCH_OPTIONS.some((o) => o.startsWith('--video-timing-offset'))).toBe(false);
    expect(LAUNCH_OPTIONS.some((o) => o.startsWith('--flatten-editions'))).toBe(false);
    expect(args.slice(LAUNCH_OPTIONS.length)).toEqual([
      '--input-conf=C:\\r\\mpv-input.conf',
      '--wid=42',
      '--input-ipc-server=\\\\.\\pipe\\elv-mpv-0123456789abcdef',
      '--elv-parent-pid=7',
    ]);
    expect(args.join(' ')).not.toMatch(/https?:/);
  });

  it('omits curl-enabled on darwin where curl is not built into the runtime', () => {
    const args = launchArgs({
      inputConf: '/r/mpv-input.conf',
      presenterArgs: ['--geometry=1600x900+400+740'],
      transportArgs: ['--input-ipc-client=fd://3'],
      platform: 'darwin',
    });
    expect(args).not.toContain('--curl-enabled=no');
    expect(args).toContain('--load-unsafe-playlists=no');
    expect(args).toEqual([
      ...LAUNCH_OPTIONS.filter((o) => o !== '--curl-enabled=no'),
      '--input-conf=/r/mpv-input.conf',
      '--geometry=1600x900+400+740',
      '--input-ipc-client=fd://3',
    ]);
  });

  it('parameterizes hwdec profiles and adds uyvy422 only for darwin-compat on darwin (#435, #210)', () => {
    const base = {
      inputConf: '/r/mpv-input.conf',
      presenterArgs: [],
      transportArgs: [],
    };
    const autoCopy = launchArgs({ ...base, platform: 'win32', hwdec: 'auto-copy' });
    expect(autoCopy).toContain('--hwdec=auto-copy');
    expect(autoCopy).not.toContain('--hwdec=auto-safe');
    expect(autoCopy.some((a) => a.startsWith('--hwdec-image-format='))).toBe(false);

    const software = launchArgs({ ...base, platform: 'win32', hwdec: 'no' });
    expect(software).toContain('--hwdec=no');
    expect(software).not.toContain('--hwdec=auto-safe');

    const darwinCompat = launchArgs({ ...base, platform: 'darwin', hwdec: 'darwin-compat' });
    expect(darwinCompat).toContain('--hwdec=auto-safe');
    expect(darwinCompat).toContain('--hwdec-image-format=uyvy422');

    const winCompat = launchArgs({ ...base, platform: 'win32', hwdec: 'darwin-compat' });
    expect(winCompat).toContain('--hwdec=auto-safe');
    expect(winCompat.some((a) => a.startsWith('--hwdec-image-format='))).toBe(false);
  });

  it('switches to --force-window=no, --vo=libmpv, and --video-timing-offset=0 only when renderContext is true (#210, #95)', () => {
    const base = {
      inputConf: '/r/mpv-input.conf',
      presenterArgs: [],
      transportArgs: [],
      platform: 'win32',
    };
    const defaultArgs = launchArgs(base);
    expect(defaultArgs).toContain('--force-window=immediate');
    expect(defaultArgs).not.toContain('--force-window=no');
    expect(defaultArgs).not.toContain('--vo=libmpv');
    expect(defaultArgs).not.toContain('--video-timing-offset=0');

    const falseArgs = launchArgs({ ...base, renderContext: false });
    expect(falseArgs).toContain('--force-window=immediate');
    expect(falseArgs).not.toContain('--force-window=no');
    expect(falseArgs).not.toContain('--vo=libmpv');
    expect(falseArgs).not.toContain('--video-timing-offset=0');

    const renderArgs = launchArgs({ ...base, renderContext: true });
    expect(renderArgs).not.toContain('--force-window=immediate');
    expect(renderArgs).toContain('--force-window=no');
    expect(renderArgs).toContain('--vo=libmpv');
    expect(renderArgs).toContain('--video-timing-offset=0');
  });

  it('emits --pulse-buffer=50 only on linux (#269)', () => {
    const base = {
      inputConf: '/r/mpv-input.conf',
      presenterArgs: [],
      transportArgs: [],
    };
    expect(launchArgs({ ...base, platform: 'linux' })).toContain('--pulse-buffer=50');
    expect(launchArgs({ ...base, platform: 'win32' })).not.toContain('--pulse-buffer=50');
    expect(launchArgs({ ...base, platform: 'darwin' })).not.toContain('--pulse-buffer=50');
    expect(launchArgs(base)).not.toContain('--pulse-buffer=50');
  });

  it('appends --sub-fonts-dir only when fontsDir is a non-empty string (#163)', () => {
    const base = {
      inputConf: '/r/mpv-input.conf',
      presenterArgs: [],
      transportArgs: [],
    };
    expect(launchArgs({ ...base, fontsDir: '/res/fonts' })).toContain('--sub-fonts-dir=/res/fonts');
    expect(
      launchArgs({ ...base, fontsDir: '' }).some((a) => a.startsWith('--sub-fonts-dir=')),
    ).toBe(false);
    expect(launchArgs(base).some((a) => a.startsWith('--sub-fonts-dir='))).toBe(false);
  });
});

describe('headerOptions and headerFields', () => {
  it('user-agent uses its own option', () => {
    expect(headerOptions({ 'User-Agent': 'VLC/3' })).toEqual({ 'user-agent': 'VLC/3' });
    expect(headerFields({ 'User-Agent': 'VLC/3' })).toEqual([]);
  });
  it('referer maps to referrer', () => {
    expect(headerOptions({ Referer: 'http://r/' })).toEqual({ referrer: 'http://r/' });
    expect(headerOptions({ referrer: 'http://r/' })).toEqual({ referrer: 'http://r/' });
    expect(headerFields({ Referer: 'http://r/', referrer: 'http://r/' })).toEqual([]);
  });
  it('returns custom headers as verbatim list entries without string-list escaping', () => {
    const headers = {
      'User-Agent': 'elv',
      'X-A': 'foo\\',
      'X-B': 'bar',
      'X-C': 'v\\,Authorization: Bearer injected',
    };
    expect(headerOptions(headers)).toEqual({ 'user-agent': 'elv' });
    expect(headerFields(headers)).toEqual([
      'X-A: foo\\',
      'X-B: bar',
      'X-C: v\\,Authorization: Bearer injected',
    ]);
  });
  it('deduplicates headers/Cookies case-insensitively and strips ASCII control chars (#303)', () => {
    const headers = {
      cookie: 'sid=old\r\nInjected: bad',
      Cookie: 'sid=new\u0000\u007f',
      authorization: 'Bearer 1',
      Authorization: 'Bearer 2\n',
      'User-Agent': 'ELV\r\nPlayer',
      Referer: 'http://ref.example/\n',
    };
    expect(headerOptions(headers)).toEqual({
      'user-agent': 'ELVPlayer',
      referrer: 'http://ref.example/',
    });
    expect(headerFields(headers)).toEqual(['Cookie: sid=new', 'Authorization: Bearer 2']);
  });
  it('returns nothing for no headers', () => {
    expect(headerOptions({})).toEqual({});
    expect(headerFields({})).toEqual([]);
  });
});

describe('loadfileCommand', () => {
  const base = { url: 'http://h/1.ts', headers: {} };
  it('loadfile uses replace, index -1 and string option values', () => {
    const cmd = loadfileCommand({ ...base, kind: 'live' });
    expect(cmd.slice(0, 4)).toEqual(['loadfile', 'http://h/1.ts', 'replace', -1]);
    const opts = cmd[4] as Record<string, string>;
    expect(Object.values(opts).every((v) => typeof v === 'string')).toBe(true);
    expect(opts).not.toHaveProperty('async');
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
  it('live and vod get their cache limits including bounded 128MiB live back-buffer (#244, #28)', () => {
    expect(loadfileCommand({ ...base, kind: 'live' })[4]).toEqual({
      'demuxer-max-bytes': '32MiB',
      'demuxer-max-back-bytes': '128MiB',
      'secondary-sub-pos': '10',
    });
    expect(loadfileCommand({ ...base, kind: 'vod', headers: { 'User-Agent': 'u' } })[4]).toEqual({
      'user-agent': 'u',
      'demuxer-max-bytes': '64MiB',
      'demuxer-max-back-bytes': '16MiB',
      'demuxer-hysteresis-secs': '10',
      'secondary-sub-pos': '10',
    });
  });

  it('forwards preferHevcOverDolbyVision as hwdec=no and filterSdhSubtitles as sub-filter-sdh (#124, #310)', () => {
    const dvOpts = loadfileCommand({
      ...base,
      kind: 'vod',
      preferHevcOverDolbyVision: true,
      filterSdhSubtitles: true,
    })[4] as Record<string, string>;
    expect(dvOpts['hwdec']).toBe('no');
    expect(dvOpts['sub-filter-sdh']).toBe('yes');

    const offOpts = loadfileCommand({
      ...base,
      kind: 'vod',
      preferHevcOverDolbyVision: false,
      filterSdhSubtitles: false,
    })[4] as Record<string, string>;
    expect(offOpts).not.toHaveProperty('hwdec');
    expect(offOpts['sub-filter-sdh']).toBe('no');
  });

  it('supports append-play mode for gapless VOD queueing (#205)', () => {
    const cmd = loadfileCommand(
      { ...base, kind: 'vod', preferHevcOverDolbyVision: true, filterSdhSubtitles: true },
      'append-play',
    );
    expect(cmd.slice(0, 4)).toEqual(['loadfile', 'http://h/1.ts', 'append-play', -1]);
    expect(cmd[4]).toMatchObject({
      'demuxer-max-bytes': '64MiB',
      'demuxer-max-back-bytes': '16MiB',
      'demuxer-hysteresis-secs': '10',
      hwdec: 'no',
      'sub-filter-sdh': 'yes',
    });
  });
});
