import { describe, expect, it } from 'vitest';
import {
  DESKTOP_CAPABILITIES,
  isGateReport,
  isPlayerAreaMessage,
  isPlayerCommandMessage,
  PLAYER_CHANNELS,
  sanitizeDesktopArtworkUrl,
  sanitizeDesktopMediaMetadata,
} from './player-ipc.ts';

const load = {
  attempt: 3,
  url: 'http://sim.test/live/demo/demo/1001.ts',
  headers: { 'User-Agent': 'elv', Referer: 'http://sim.test/' },
  kind: 'live',
};
const msg = (command: unknown) => ({ engineId: 'e1', command });

describe('PLAYER_CHANNELS', () => {
  it('uses the exact channel names', () => {
    expect(PLAYER_CHANNELS).toEqual({
      open: 'player:open',
      close: 'player:close',
      setPrimary: 'player:set-primary',
      command: 'player:command',
      event: 'player:event',
      area: 'player:area',
      ui: 'player:ui',
      remoteMediaAction: 'player:remote-media-action',
      pickSubtitleFile: 'player:pick-subtitle-file',
      gateReport: 'gate:report',
    });
  });
});

describe('DESKTOP_CAPABILITIES', () => {
  it('is frozen and enables bounded liveSeek (#28)', () => {
    expect(Object.isFrozen(DESKTOP_CAPABILITIES)).toBe(true);
    expect(DESKTOP_CAPABILITIES.liveSeek).toBe(true);
  });
});

describe('isPlayerCommandMessage', () => {
  it('accepts each BridgeCommand variant', () => {
    const variants: unknown[] = [
      { name: 'load', cmd: load },
      {
        name: 'load',
        cmd: {
          ...load,
          kind: 'vod',
          startMs: 1500,
          options: {
            softwareAudio: true,
            preferHevcOverDolbyVision: true,
            filterSdhSubtitles: true,
            allowLegacyTls: true,
            audioTrackId: 'a:2',
            subtitleTrackId: null,
          },
        },
      },
      {
        name: 'load',
        cmd: { ...load, options: { subtitleTrackId: 's:1' } },
      },
      {
        name: 'load',
        cmd: {
          ...load,
          options: { dnsFamily: 'system', hostOverride: '203.0.113.10' },
        },
      },
      {
        name: 'load',
        cmd: {
          ...load,
          options: { dnsFamily: 'ipv4', hostOverride: '198.51.100.25' },
        },
      },
      {
        name: 'load',
        cmd: {
          ...load,
          options: { dnsFamily: 'ipv6', hostOverride: '[2001:db8::1]' },
        },
      },
      {
        name: 'load',
        cmd: {
          ...load,
          options: { dnsFamily: 'ipv6', hostOverride: '2001:db8::2' },
        },
      },
      { name: 'retry', attempt: 4 },
      { name: 'play', attempt: 4 },
      { name: 'pause', attempt: 4 },
      { name: 'stop', attempt: 4 },
      { name: 'recreate', attempt: 4 },
      { name: 'jumpToLiveEdge', attempt: 4 },
      { name: 'seek', attempt: 4, positionMs: 12000 },
      { name: 'setSpeed', attempt: 4, rate: 0.25 },
      { name: 'setSpeed', attempt: 4, rate: 1.5 },
      { name: 'setSpeed', attempt: 4, rate: 4 },
      { name: 'selectAudioTrack', attempt: 4, id: 'a:2' },
      { name: 'selectSubtitleTrack', attempt: 4, id: 's:1' },
      { name: 'selectSubtitleTrack', attempt: 4, id: null },
      { name: 'setVolume', volume: 0 },
      { name: 'setVolume', volume: 100 },
      { name: 'setAudioDelay', delaySec: -30 },
      { name: 'setAudioDelay', delaySec: 0.25 },
      { name: 'setAudioDelay', delaySec: 30 },
      { name: 'setSubtitleDelay', delaySec: -0.5 },
      { name: 'setAudioDevice', device: 'auto' },
      { name: 'setAudioDevice', device: 'wasapi/{1234}' },
      { name: 'setAudioDevice', device: 'a'.repeat(160) },
      { name: 'setDeinterlace', enabled: true },
      { name: 'setDeinterlace', enabled: false },
      { name: 'setDeinterlaceMode', mode: 'off' },
      { name: 'setDeinterlaceMode', mode: 'auto' },
      { name: 'setDeinterlaceMode', mode: 'bwdif' },
      { name: 'setPitchLock', locked: true },
      { name: 'setPitchLock', locked: false },
      { name: 'setAudioNormalization', enabled: true },
      { name: 'setAudioNormalization', enabled: false },
      {
        name: 'queueNext',
        request: {
          itemKey: 'xtream:s1:ep:102',
          stream: {
            url: 'https://sim.test/series/demo/demo/102.mkv',
            headers: { 'User-Agent': 'ELV/1' },
          },
          preferHevcOverDolbyVision: true,
          filterSdhSubtitles: false,
        },
      },
      { name: 'clearQueue' },
      { name: 'setHwdec', profile: 'auto-safe' },
      { name: 'setHwdec', profile: 'auto-copy' },
      { name: 'setHwdec', profile: 'no' },
      { name: 'setHwdec', profile: 'darwin-compat' },
      { name: 'setResizeMode', mode: 'fit' },
      { name: 'setResizeMode', mode: 'fill' },
      { name: 'setResizeMode', mode: 'stretch' },
      { name: 'setFilterSdh', enabled: true },
      { name: 'setFilterSdh', enabled: false },
      { name: 'setSubtitleFontFamily', family: 'system' },
      { name: 'setSubtitleFontFamily', family: 'atkinson' },
      { name: 'setSubtitleFontFamily', family: 'opendyslexic' },
      { name: 'setMediaMetadata', metadata: null },
      {
        name: 'setMediaMetadata',
        metadata: {
          title: 'Channel One',
          subtitle: 'Live News',
          artworkUrl: 'https://cdn.example.test/logo.png',
          kind: 'live',
          canStepTrack: true,
        },
      },
      {
        name: 'setMediaMetadata',
        metadata: { title: 'Movie', kind: 'vod', canStepTrack: false },
      },
      { name: 'release' },
      { name: 'fullscreen' },
      { name: 'mute' },
    ];
    for (const command of variants) expect(isPlayerCommandMessage(msg(command))).toBe(true);
  });

  it('drops a file: url', () => {
    for (const url of [
      'http:x/a.ts',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
      '',
      'ftp://x/y',
    ]) {
      expect(isPlayerCommandMessage(msg({ name: 'load', cmd: { ...load, url } }))).toBe(false);
    }
  });

  it('drops a header value with CR or LF', () => {
    for (const value of ['a\r\nX: 1', 'a\nb', 'a\rb', 'a\u0000b', 'a\u007fb']) {
      expect(
        isPlayerCommandMessage(
          msg({ name: 'load', cmd: { ...load, headers: { 'X-Key': value } } }),
        ),
      ).toBe(false);
    }
  });

  it('drops a header name that is not an RFC 9110 token', () => {
    for (const name of [
      'X\nKey',
      'X:Key',
      '',
      'X Key\t',
      'X Key',
      'X,Key',
      'X\\Key',
      'X"Key',
      'X(Key)',
      'X/Key',
      'X=Key',
    ]) {
      expect(
        isPlayerCommandMessage(msg({ name: 'load', cmd: { ...load, headers: { [name]: 'v' } } })),
      ).toBe(false);
    }
    expect(
      isPlayerCommandMessage(
        msg({
          name: 'load',
          cmd: { ...load, headers: { "X-Key_1.2!#$%&'*+^`|~": 'v' } },
        }),
      ),
    ).toBe(true);
  });

  it('drops an unknown shape', () => {
    const bad: unknown[] = [
      null,
      'load',
      42,
      {},
      { engineId: 'e1' },
      { engineId: '', command: { name: 'release' } },
      { engineId: 7, command: { name: 'release' } },
      msg(null),
      msg({ name: 'explode' }),
      msg({ name: 'play' }),
      msg({ name: 'play', attempt: 'x' }),
      msg({ name: 'play', attempt: -1 }),
      msg({ name: 'play', attempt: 1.5 }),
      msg({ name: 'jumpToLiveEdge' }),
      msg({ name: 'jumpToLiveEdge', attempt: -1 }),
      msg({ name: 'jumpToLiveEdge', attempt: 'bad' }),
      msg({ name: 'seek', attempt: 1 }),
      msg({ name: 'seek', attempt: 1, positionMs: Number.NaN }),
      msg({ name: 'seek', attempt: 1, positionMs: -5 }),
      msg({ name: 'setSpeed', attempt: 1 }),
      msg({ name: 'setSpeed', attempt: -1, rate: 1 }),
      msg({ name: 'setSpeed', attempt: 1, rate: 0.24 }),
      msg({ name: 'setSpeed', attempt: 1, rate: 4.01 }),
      msg({ name: 'setSpeed', attempt: 1, rate: Number.NaN }),
      msg({ name: 'setSpeed', attempt: 1, rate: Number.POSITIVE_INFINITY }),
      msg({ name: 'setVolume', volume: -1 }),
      msg({ name: 'setVolume', volume: 101 }),
      msg({ name: 'setVolume', volume: Number.NaN }),
      msg({ name: 'setVolume', volume: '50' }),
      msg({ name: 'setAudioDelay', delaySec: -30.1 }),
      msg({ name: 'setAudioDelay', delaySec: 30.1 }),
      msg({ name: 'setAudioDelay', delaySec: Number.POSITIVE_INFINITY }),
      msg({ name: 'setSubtitleDelay', delaySec: -31 }),
      msg({ name: 'setSubtitleDelay', delaySec: Number.NaN }),
      msg({ name: 'setAudioDevice', device: '' }),
      msg({ name: 'setAudioDevice', device: 'a'.repeat(161) }),
      msg({ name: 'setAudioDevice', device: 'a'.repeat(257) }),
      msg({ name: 'setAudioDevice', device: 'wasapi/spk\n' }),
      msg({ name: 'setAudioDevice', device: 123 }),
      msg({ name: 'setDeinterlace', enabled: 'yes' }),
      msg({ name: 'setDeinterlace' }),
      msg({ name: 'setDeinterlaceMode' }),
      msg({ name: 'setDeinterlaceMode', mode: 'yadif' }),
      msg({ name: 'setDeinterlaceMode', mode: true }),
      msg({ name: 'setPitchLock' }),
      msg({ name: 'setPitchLock', locked: 'yes' }),
      msg({ name: 'setAudioNormalization' }),
      msg({ name: 'setAudioNormalization', enabled: 'yes' }),
      msg({ name: 'queueNext' }),
      msg({ name: 'queueNext', request: null }),
      msg({
        name: 'queueNext',
        request: {
          itemKey: '',
          stream: { url: 'http://sim.test/ep2.mkv', headers: {} },
        },
      }),
      msg({
        name: 'queueNext',
        request: {
          itemKey: 'ep2\n',
          stream: { url: 'http://sim.test/ep2.mkv', headers: {} },
        },
      }),
      msg({
        name: 'queueNext',
        request: {
          itemKey: 'ep2',
          kind: 'live',
          stream: { url: 'http://sim.test/ep2.mkv', headers: {} },
        },
      }),
      msg({
        name: 'queueNext',
        request: {
          itemKey: 'ep2',
          stream: { url: 'file:///etc/passwd', headers: {} },
        },
      }),
      msg({
        name: 'queueNext',
        request: {
          itemKey: 'ep2',
          stream: { url: 'http://sim.test/ep2.mkv', headers: { 'X-Bad\n': '1' } },
        },
      }),
      msg({
        name: 'queueNext',
        request: {
          itemKey: 'ep2',
          stream: { url: 'http://sim.test/ep2.mkv', headers: {} },
          preferHevcOverDolbyVision: 'yes',
        },
      }),
      msg({ name: 'setHwdec' }),
      msg({ name: 'setHwdec', profile: '' }),
      msg({ name: 'setHwdec', profile: 'vaapi' }),
      msg({ name: 'setHwdec', profile: 42 }),
      msg({ name: 'setResizeMode' }),
      msg({ name: 'setResizeMode', mode: 'zoom' }),
      msg({ name: 'setResizeMode', mode: 1 }),
      msg({ name: 'setFilterSdh' }),
      msg({ name: 'setFilterSdh', enabled: 'yes' }),
      msg({ name: 'setSubtitleFontFamily' }),
      msg({ name: 'setSubtitleFontFamily', family: '' }),
      msg({ name: 'setSubtitleFontFamily', family: 'comic-sans' }),
      msg({ name: 'setSubtitleFontFamily', family: 'Atkinson Hyperlegible Next' }),
      msg({ name: 'setSubtitleFontFamily', family: 42 }),
      msg({ name: 'setMediaMetadata' }),
      msg({ name: 'setMediaMetadata', metadata: 'bad' }),
      msg({ name: 'setMediaMetadata', metadata: { title: 42, kind: 'live', canStepTrack: true } }),
      msg({
        name: 'setMediaMetadata',
        metadata: { title: 'Ch\n1', kind: 'live', canStepTrack: true },
      }),
      msg({
        name: 'setMediaMetadata',
        metadata: { title: 'Ch', subtitle: 'Sub\r', kind: 'live', canStepTrack: true },
      }),
      msg({
        name: 'setMediaMetadata',
        metadata: { title: 'Ch', artworkUrl: 'http://x/\n', kind: 'live', canStepTrack: true },
      }),
      msg({
        name: 'setMediaMetadata',
        metadata: { title: 'Ch', kind: 'radio', canStepTrack: true },
      }),
      msg({
        name: 'setMediaMetadata',
        metadata: { title: 'Ch', kind: 'live', canStepTrack: 'yes' },
      }),
      msg({ name: 'load', cmd: { ...load, options: { filterSdhSubtitles: 'yes' } } }),
      msg({ name: 'load', cmd: { ...load, options: { allowLegacyTls: 'yes' } } }),
      msg({ name: 'load', cmd: { ...load, options: { dnsFamily: 'ipv5' } } }),
      msg({ name: 'load', cmd: { ...load, options: { dnsFamily: 'IPV4' } } }),
      msg({ name: 'load', cmd: { ...load, options: { dnsFamily: 4 } } }),
      msg({ name: 'load', cmd: { ...load, options: { dnsFamily: '' } } }),
      msg({ name: 'load', cmd: { ...load, options: { hostOverride: '' } } }),
      msg({ name: 'load', cmd: { ...load, options: { hostOverride: '   ' } } }),
      msg({ name: 'load', cmd: { ...load, options: { hostOverride: 'evil.example' } } }),
      msg({ name: 'load', cmd: { ...load, options: { hostOverride: '203.0.113.1:8080' } } }),
      msg({ name: 'load', cmd: { ...load, options: { hostOverride: 'http://203.0.113.1' } } }),
      msg({ name: 'load', cmd: { ...load, options: { hostOverride: '203.0.113.1\n' } } }),
      msg({ name: 'load', cmd: { ...load, options: { hostOverride: 'fe80::1%eth0' } } }),
      msg({ name: 'load', cmd: { ...load, options: { hostOverride: 123 } } }),
      msg({ name: 'load', cmd: { ...load, options: { hostOverride: null } } }),
      msg({ name: 'load', cmd: { ...load, options: { hostOverride: '1'.repeat(100) } } }),
      msg({
        name: 'load',
        cmd: { ...load, options: { hostOverride: `${' '.repeat(80)}203.0.113.1` } },
      }),
      msg({
        name: 'queueNext',
        request: {
          itemKey: 'ep2',
          stream: { url: 'http://sim.test/ep2.mkv', headers: {}, dnsFamily: 'ipv5' },
        },
      }),
      msg({
        name: 'queueNext',
        request: {
          itemKey: 'ep2',
          stream: { url: 'http://sim.test/ep2.mkv', headers: {}, hostOverride: 'evil.example' },
        },
      }),
      msg({ name: 'load' }),
      msg({ name: 'load', cmd: null }),
      msg({ name: 'load', cmd: { ...load, kind: 'radio' } }),
      msg({ name: 'load', cmd: { ...load, attempt: 'x' } }),
      msg({ name: 'load', cmd: { ...load, headers: null } }),
      msg({ name: 'load', cmd: { ...load, headers: { a: 1 } } }),
      msg({ name: 'load', cmd: { ...load, startMs: -1 } }),
      msg({ name: 'load', cmd: { ...load, startMs: 'x' } }),
      msg({ name: 'load', cmd: { ...load, options: { softwareAudio: 'yes' } } }),
      msg({ name: 'load', cmd: { ...load, options: { audioTrackId: '' } } }),
      msg({ name: 'load', cmd: { ...load, options: { audioTrackId: 'a:1\n' } } }),
      msg({ name: 'load', cmd: { ...load, options: { subtitleTrackId: 2 } } }),
      msg({ name: 'selectAudioTrack', attempt: 1, id: null }),
      msg({ name: 'selectAudioTrack', attempt: 1, id: '' }),
      msg({ name: 'selectAudioTrack', attempt: 1, id: 's:1' }),
      msg({ name: 'selectAudioTrack', attempt: 1, id: 'a:0' }),
      msg({ name: 'selectAudioTrack', attempt: 1, id: 'a:1234567' }),
      msg({ name: 'selectSubtitleTrack', attempt: 1, id: '' }),
      msg({ name: 'selectSubtitleTrack', attempt: 1, id: 'a:1' }),
      msg({ name: 'selectSubtitleTrack', attempt: 1, id: 's:0' }),
      msg({ name: 'selectSubtitleTrack', attempt: 1, id: 's:1234567' }),
      msg({ name: 'selectSubtitleTrack', attempt: 1, id: 's:1\r' }),
      msg({ name: 'load', cmd: { ...load, options: null } }),
      msg({ name: 'load', cmd: { ...load, options: { audioTrackId: 's:1' } } }),
      msg({ name: 'load', cmd: { ...load, options: { subtitleTrackId: 'a:1' } } }),
      msg({ name: 'play', attempt: Number.MAX_SAFE_INTEGER + 1 }),
      msg({ name: 'seek', attempt: 1, positionMs: 86_400_000_001 }),
      msg({ name: 'load', cmd: { ...load, startMs: 86_400_000_001 } }),
      msg({ name: 'load', cmd: { ...load, url: `http://sim.test/${'a'.repeat(9000)}` } }),
      msg({ name: 'load', cmd: { ...load, headers: [] } }),
      msg({
        name: 'load',
        cmd: {
          ...load,
          headers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`X-H-${i}`, '1'])),
        },
      }),
      msg({
        name: 'load',
        cmd: { ...load, headers: { 'X-Too-Long': 'v'.repeat(9000) } },
      }),
      [],
    ];
    for (const m of bad) expect(isPlayerCommandMessage(m)).toBe(false);
  });

  it('rejects prototype-polluting own keys (__proto__, constructor, prototype) in command, headers, options, and area', () => {
    const protoTop = JSON.parse(
      '{"engineId":"e1","command":{"name":"release"},"__proto__":{"x":1}}',
    );
    const protoCmd = JSON.parse(
      '{"engineId":"e1","command":{"name":"release","constructor":"bad"}}',
    );
    const protoHeaders = JSON.parse(
      `{"engineId":"e1","command":{"name":"load","cmd":{"attempt":1,"url":"http://sim.test/1.ts","kind":"live","headers":{"__proto__":"bad"}}}}`,
    );
    const ctorHeaders = JSON.parse(
      `{"engineId":"e1","command":{"name":"load","cmd":{"attempt":1,"url":"http://sim.test/1.ts","kind":"live","headers":{"constructor":"bad"}}}}`,
    );
    const protoOptions = JSON.parse(
      `{"engineId":"e1","command":{"name":"load","cmd":{"attempt":1,"url":"http://sim.test/1.ts","kind":"live","headers":{},"options":{"prototype":"bad"}}}}`,
    );
    const protoArea = JSON.parse(
      '{"engineId":"e1","area":{"x":0,"y":0,"width":100,"height":100,"visible":true,"__proto__":{"polluted":true}}}',
    );

    expect(isPlayerCommandMessage(protoTop)).toBe(false);
    expect(isPlayerCommandMessage(protoCmd)).toBe(false);
    expect(isPlayerCommandMessage(protoHeaders)).toBe(false);
    expect(isPlayerCommandMessage(ctorHeaders)).toBe(false);
    expect(isPlayerCommandMessage(protoOptions)).toBe(false);
    expect(isPlayerAreaMessage(protoArea)).toBe(false);
  });
});

describe('isPlayerAreaMessage', () => {
  const area = { x: 0, y: 40, width: 800, height: 450, visible: true };

  it('accepts a player area', () => {
    expect(isPlayerAreaMessage({ engineId: 'e1', area })).toBe(true);
  });

  it('drops a malformed area', () => {
    const bad: unknown[] = [
      null,
      { engineId: 'e1' },
      { engineId: '', area },
      { engineId: 'e1', area: null },
      { engineId: 'e1', area: { ...area, x: Number.NaN } },
      { engineId: 'e1', area: { ...area, width: Number.POSITIVE_INFINITY } },
      { engineId: 'e1', area: { ...area, height: '450' } },
      { engineId: 'e1', area: { ...area, x: 1e7 } },
      { engineId: 'e1', area: { ...area, y: -1e7 } },
      { engineId: 'e1', area: { ...area, width: -1 } },
      { engineId: 'e1', area: { ...area, height: -0.5 } },
      { engineId: 'e1', area: { ...area, visible: 1 } },
      { engineId: 'e1', area: { x: 0, y: 0, width: 1, height: 1 } },
    ];
    for (const m of bad) expect(isPlayerAreaMessage(m)).toBe(false);
  });
});

describe('isGateReport', () => {
  it('accepts a gate line', () => {
    expect(isGateReport('ELV_GATE_PLAYER {"verdict":"pass"}')).toBe(true);
  });

  it('drops other text, non-strings and oversized lines', () => {
    expect(isGateReport('hello')).toBe(false);
    expect(isGateReport('ELV_GATE_PLAYER')).toBe(false);
    expect(isGateReport(7)).toBe(false);
    expect(isGateReport('ELV_GATE_PLAYER {"a":1}\nsecond line')).toBe(false);
    expect(isGateReport('ELV_GATE_PLAYER {"a":1}\r')).toBe(false);
    expect(isGateReport(`ELV_GATE_PLAYER {"x":"${'a'.repeat(64 * 1024)}"}`)).toBe(false);
    expect(isGateReport(`ELV_GATE_PLAYER {${'a'.repeat(64 * 1024 - 17)}`)).toBe(true);
  });
});

describe('sanitizeDesktopArtworkUrl & sanitizeDesktopMediaMetadata', () => {
  it('strips userinfo and credential query params and rejects non-http(s) artwork URLs', () => {
    expect(
      sanitizeDesktopArtworkUrl('https://alice:secret@cdn.example.test/art.jpg?token=xyz&w=320'),
    ).toBe('https://cdn.example.test/art.jpg?w=320');
    expect(sanitizeDesktopArtworkUrl('file:///etc/passwd')).toBeUndefined();
    expect(sanitizeDesktopArtworkUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeDesktopArtworkUrl('https://cdn.example.test/a\nb')).toBeUndefined();
    expect(sanitizeDesktopMediaMetadata(null)).toBeNull();
    expect(
      sanitizeDesktopMediaMetadata({
        title: '  Channel 1  ',
        subtitle: '  Evening  ',
        artworkUrl: 'https://user:pass@cdn.example.test/p.png?api_key=k&h=100',
        kind: 'live',
        canStepTrack: true,
      }),
    ).toEqual({
      title: 'Channel 1',
      subtitle: 'Evening',
      artworkUrl: 'https://cdn.example.test/p.png?h=100',
      kind: 'live',
      canStepTrack: true,
    });
    expect(
      sanitizeDesktopMediaMetadata({
        title: 'Movie',
        subtitle: '   ',
        artworkUrl: 'file:///local/secret.png',
        kind: 'vod',
        canStepTrack: false,
      }),
    ).toEqual({
      title: 'Movie',
      kind: 'vod',
      canStepTrack: false,
    });
  });
});
