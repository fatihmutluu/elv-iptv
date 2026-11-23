import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopMediaCommand } from '../media-bridge.ts';
import {
  DBUS_MSG_TYPE,
  type DbusMessage,
  type DbusVariant,
  dbusVariant,
  encodeDbusMessage,
  tryDecodeDbusMessage,
} from './dbus-wire.ts';
import { createMprisBridge } from './mpris-bridge.ts';

function createFakeDbusDaemon(opts?: { requestNameReply?: (busName: string) => number }) {
  let clientEnd!: Duplex;
  let serverEnd!: Duplex;
  clientEnd = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      serverEnd.push(chunk);
      cb();
    },
    final(cb) {
      serverEnd.push(null);
      cb();
    },
  });
  serverEnd = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      clientEnd.push(chunk);
      cb();
    },
    final(cb) {
      clientEnd.push(null);
      cb();
    },
  });

  const receivedFromClient: DbusMessage[] = [];
  let rx: Buffer = Buffer.alloc(0);
  let sawAuth = false;
  let began = false;
  let serverSerial = 1000;

  const sendToClient = (msg: Omit<DbusMessage, 'serial'>): number => {
    const serial = ++serverSerial;
    serverEnd.write(encodeDbusMessage({ ...msg, serial }));
    return serial;
  };

  serverEnd.on('data', (chunk: Buffer) => {
    rx = Buffer.concat([rx, chunk]);
    if (!sawAuth) {
      const eol = rx.indexOf('\r\n');
      if (eol === -1) return;
      sawAuth = true;
      rx = rx.subarray(eol + 2);
      serverEnd.write('OK deadbeef\r\n');
    }
    if (sawAuth && !began) {
      const idx = rx.indexOf('BEGIN\r\n');
      if (idx === -1) return;
      began = true;
      rx = rx.subarray(idx + 'BEGIN\r\n'.length);
    }
    while (began && rx.length >= 16) {
      const decoded = tryDecodeDbusMessage(rx);
      if (!decoded) break;
      rx = rx.subarray(decoded.bytesRead);
      const m = decoded.message;
      receivedFromClient.push(m);
      if (m.type === DBUS_MSG_TYPE.METHOD_CALL && m.destination === 'org.freedesktop.DBus') {
        if (m.member === 'Hello') {
          sendToClient({
            type: DBUS_MSG_TYPE.METHOD_RETURN,
            flags: 0,
            replySerial: m.serial,
            signature: 's',
            body: [':1.10'],
          });
        } else if (m.member === 'RequestName') {
          const requested = String(m.body[0] ?? '');
          const replyCode = opts?.requestNameReply ? opts.requestNameReply(requested) : 1;
          sendToClient({
            type: DBUS_MSG_TYPE.METHOD_RETURN,
            flags: 0,
            replySerial: m.serial,
            signature: 'u',
            body: [replyCode],
          });
        }
      }
    }
  });

  const callOnBridge = async (
    iface: string,
    member: string,
    signature = '',
    body: readonly unknown[] = [],
    path = '/org/mpris/MediaPlayer2',
  ): Promise<DbusMessage> => {
    const serial = sendToClient({
      type: DBUS_MSG_TYPE.METHOD_CALL,
      flags: 0,
      sender: ':1.99',
      path,
      interface: iface,
      member,
      ...(signature ? { signature } : {}),
      body,
    });
    await vi.waitFor(() => {
      const found = receivedFromClient.find((m) => m.replySerial === serial);
      if (!found) throw new Error('waiting for reply');
    });
    return receivedFromClient.find((m) => m.replySerial === serial) as DbusMessage;
  };

  return {
    connect: () => clientEnd,
    receivedFromClient,
    callOnBridge,
    signals: () => receivedFromClient.filter((m) => m.type === DBUS_MSG_TYPE.SIGNAL),
  };
}

afterEach(() => vi.useRealTimers());

describe('createMprisBridge (#238)', () => {
  it('degrades silently to no-op on non-linux or when DBUS_SESSION_BUS_ADDRESS is missing/invalid', () => {
    const nonLinux = createMprisBridge({
      platform: 'win32',
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    });
    expect(() => {
      nonLinux.updateState({
        status: 'Playing',
        isNavigating: false,
        kind: 'live',
        positionUs: 0,
        durationUs: 0,
        rate: 1,
        volume: 1,
        metadata: null,
      });
      nonLinux.notifySeeked?.(1000);
      nonLinux.onCommand(() => undefined)();
      nonLinux.dispose();
    }).not.toThrow();

    const noEnv = createMprisBridge({ platform: 'linux', env: {} });
    expect(() => noEnv.dispose()).not.toThrow();

    const badEnv = createMprisBridge({
      platform: 'linux',
      env: { DBUS_SESSION_BUS_ADDRESS: 'tcp:host=127.0.0.1,port=1234' },
    });
    expect(() => badEnv.dispose()).not.toThrow();
  });

  it('registers org.mpris.MediaPlayer2.elv_iptv, serves Introspect/Properties/Root/Player, and emits signals', async () => {
    const daemon = createFakeDbusDaemon();
    const onRaise = vi.fn();
    const onQuit = vi.fn();
    let isReady = false;

    const bridge = createMprisBridge({
      platform: 'linux',
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      connect: daemon.connect,
      getUid: () => 1000,
      onRaise,
      onQuit,
      onReady: () => {
        isReady = true;
      },
    });
    const commands: DesktopMediaCommand[] = [];
    bridge.onCommand((c) => commands.push(c));

    await vi.waitFor(() => expect(isReady).toBe(true));

    const reqName = daemon.receivedFromClient.find((m) => m.member === 'RequestName');
    expect(reqName?.body[0]).toBe('org.mpris.MediaPlayer2.elv_iptv');

    // Introspect
    const introspect = await daemon.callOnBridge(
      'org.freedesktop.DBus.Introspectable',
      'Introspect',
    );
    expect(String(introspect.body[0])).toContain('org.mpris.MediaPlayer2.Player');

    // Root properties & methods
    const rootAll = await daemon.callOnBridge('org.freedesktop.DBus.Properties', 'GetAll', 's', [
      'org.mpris.MediaPlayer2',
    ]);
    const rootProps = rootAll.body[0] as Record<string, DbusVariant>;
    expect(rootProps['Identity']?.value).toBe('ELV IPTV');
    expect(rootProps['DesktopEntry']?.value).toBe('elv-iptv');
    expect(rootProps['HasTrackList']?.value).toBe(false);
    expect(rootProps['CanRaise']?.value).toBe(true);
    expect(rootProps['CanQuit']?.value).toBe(true);

    await daemon.callOnBridge('org.mpris.MediaPlayer2', 'Raise');
    await daemon.callOnBridge('org.mpris.MediaPlayer2', 'Quit');
    expect(onRaise).toHaveBeenCalledTimes(1);
    expect(onQuit).toHaveBeenCalledTimes(1);

    // Push VOD playing state with credentials in artworkUrl -> sanitized!
    bridge.updateState({
      status: 'Playing',
      isNavigating: false,
      kind: 'vod',
      positionUs: 30_000_000,
      durationUs: 120_000_000,
      rate: 1.0,
      volume: 0.8,
      metadata: {
        title: 'Synthetic Movie',
        subtitle: 'Sci-Fi',
        artworkUrl: 'https://user:secret@cdn.example.test/poster.jpg?token=abc&w=512',
        kind: 'vod',
        canStepTrack: true,
      },
    });

    await vi.waitFor(() =>
      expect(daemon.signals().some((s) => s.member === 'PropertiesChanged')).toBe(true),
    );

    const playerAll = await daemon.callOnBridge('org.freedesktop.DBus.Properties', 'GetAll', 's', [
      'org.mpris.MediaPlayer2.Player',
    ]);
    const p = playerAll.body[0] as Record<string, DbusVariant>;
    expect(p['PlaybackStatus']?.value).toBe('Playing');
    expect(p['CanSeek']?.value).toBe(true);
    expect(p['CanGoNext']?.value).toBe(true);
    expect(p['CanGoPrevious']?.value).toBe(true);
    expect(p['CanControl']?.value).toBe(true);
    expect(p['Position']?.value).toBe(30_000_000n);
    const meta = p['Metadata']?.value as Record<string, DbusVariant>;
    const trackId = String(meta['mpris:trackid']?.value);
    expect(meta['xesam:title']?.value).toBe('Synthetic Movie');
    expect(meta['xesam:artist']?.value).toEqual(['Sci-Fi']);
    expect(meta['mpris:artUrl']?.value).toBe('https://cdn.example.test/poster.jpg?w=512');
    expect(meta['mpris:length']?.value).toBe(120_000_000n);

    // Get single property & Set Rate / Volume
    const statusGet = await daemon.callOnBridge('org.freedesktop.DBus.Properties', 'Get', 'ss', [
      'org.mpris.MediaPlayer2.Player',
      'PlaybackStatus',
    ]);
    expect((statusGet.body[0] as DbusVariant).value).toBe('Playing');

    await daemon.callOnBridge('org.freedesktop.DBus.Properties', 'Set', 'ssv', [
      'org.mpris.MediaPlayer2.Player',
      'Rate',
      dbusVariant('d', 1.5),
    ]);
    await daemon.callOnBridge('org.freedesktop.DBus.Properties', 'Set', 'ssv', [
      'org.mpris.MediaPlayer2.Player',
      'Volume',
      dbusVariant('d', 0.5),
    ]);

    // Player transport methods
    await daemon.callOnBridge('org.mpris.MediaPlayer2.Player', 'Play');
    await daemon.callOnBridge('org.mpris.MediaPlayer2.Player', 'Pause');
    await daemon.callOnBridge('org.mpris.MediaPlayer2.Player', 'PlayPause');
    await daemon.callOnBridge('org.mpris.MediaPlayer2.Player', 'Stop');
    await daemon.callOnBridge('org.mpris.MediaPlayer2.Player', 'Next');
    await daemon.callOnBridge('org.mpris.MediaPlayer2.Player', 'Previous');
    await daemon.callOnBridge('org.mpris.MediaPlayer2.Player', 'Seek', 'x', [10_000_000n]);
    // SetPosition with wrong trackId or negative position ignored; valid trackId dispatches seekToUs
    await daemon.callOnBridge('org.mpris.MediaPlayer2.Player', 'SetPosition', 'ox', [
      '/wrong/track',
      50_000_000n,
    ]);
    await daemon.callOnBridge('org.mpris.MediaPlayer2.Player', 'SetPosition', 'ox', [
      trackId,
      -5_000_000n,
    ]);
    await daemon.callOnBridge('org.mpris.MediaPlayer2.Player', 'SetPosition', 'ox', [
      trackId,
      60_000_000n,
    ]);

    expect(commands).toEqual([
      { type: 'setRate', rate: 1.5 },
      { type: 'setVolume', volume: 0.5 },
      { type: 'play' },
      { type: 'pause' },
      { type: 'togglePlayPause' },
      { type: 'stop' },
      { type: 'next' },
      { type: 'previous' },
      { type: 'seekByUs', offsetUs: 10_000_000 },
      { type: 'seekToUs', positionUs: 60_000_000 },
    ]);

    // Seeked signal
    bridge.notifySeeked?.(60_000_000);
    await vi.waitFor(() => expect(daemon.signals().some((s) => s.member === 'Seeked')).toBe(true));
    const seekedSig = daemon.signals().find((s) => s.member === 'Seeked');
    expect(seekedSig?.body).toEqual([60_000_000n]);

    // Unknown property, prototype-chain names, and read-only property errors
    const unknownProp = await daemon.callOnBridge('org.freedesktop.DBus.Properties', 'Get', 'ss', [
      'org.mpris.MediaPlayer2.Player',
      'DoesNotExist',
    ]);
    expect(unknownProp.type).toBe(DBUS_MSG_TYPE.ERROR);
    for (const protoProp of ['toString', 'constructor', '__proto__']) {
      const protoErr = await daemon.callOnBridge('org.freedesktop.DBus.Properties', 'Get', 'ss', [
        'org.mpris.MediaPlayer2.Player',
        protoProp,
      ]);
      expect(protoErr.type).toBe(DBUS_MSG_TYPE.ERROR);
      expect(protoErr.errorName).toBe('org.freedesktop.DBus.Error.UnknownProperty');
    }
    const readOnly = await daemon.callOnBridge('org.freedesktop.DBus.Properties', 'Set', 'ssv', [
      'org.mpris.MediaPlayer2.Player',
      'CanControl',
      dbusVariant('b', false),
    ]);
    expect(readOnly.type).toBe(DBUS_MSG_TYPE.ERROR);

    bridge.dispose();
  });

  it('falls back to .instance<pid> when primary bus name EXISTS and closes cleanly if fallback is also declined', async () => {
    const requestedNames: string[] = [];
    const fallbackDaemon = createFakeDbusDaemon({
      requestNameReply: (name) => {
        requestedNames.push(name);
        return name === 'org.mpris.MediaPlayer2.elv_iptv' ? 3 : 1; // 3 = EXISTS, 1 = PRIMARY_OWNER
      },
    });
    let fallbackReady = false;
    const bridge = createMprisBridge({
      platform: 'linux',
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      connect: fallbackDaemon.connect,
      getUid: () => 1000,
      onReady: () => {
        fallbackReady = true;
      },
    });
    await vi.waitFor(() => expect(fallbackReady).toBe(true));
    expect(requestedNames).toEqual([
      'org.mpris.MediaPlayer2.elv_iptv',
      `org.mpris.MediaPlayer2.elv_iptv.instance${process.pid}`,
    ]);
    bridge.dispose();

    const logs: string[] = [];
    const deniedDaemon = createFakeDbusDaemon({ requestNameReply: () => 3 });
    const onReadyDenied = vi.fn();
    const deniedBridge = createMprisBridge({
      platform: 'linux',
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      connect: deniedDaemon.connect,
      getUid: () => 1000,
      log: (line) => logs.push(line),
      onReady: onReadyDenied,
    });
    await vi.waitFor(() => expect(logs.some((l) => l.includes('mpris: unavailable'))).toBe(true));
    expect(onReadyDenied).not.toHaveBeenCalled();
    deniedBridge.dispose();
  });

  it('debounces Stopped for 400ms during isNavigating channel zaps so notifications never blink', async () => {
    vi.useFakeTimers();
    const daemon = createFakeDbusDaemon();
    let isReady = false;
    const bridge = createMprisBridge({
      platform: 'linux',
      env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
      connect: daemon.connect,
      getUid: () => 1000,
      navigatingDebounceMs: 400,
      onReady: () => {
        isReady = true;
      },
    });
    await vi.waitFor(() => expect(isReady).toBe(true));

    bridge.updateState({
      status: 'Playing',
      isNavigating: false,
      kind: 'live',
      positionUs: 0,
      durationUs: 0,
      rate: 1,
      volume: 1,
      metadata: { title: 'Ch 1', kind: 'live', canStepTrack: true },
    });
    await Promise.resolve();

    // Zap begins: transient Stopped + isNavigating=true -> must NOT publish Stopped yet!
    bridge.updateState({
      status: 'Stopped',
      isNavigating: true,
      kind: 'live',
      positionUs: 0,
      durationUs: 0,
      rate: 1,
      volume: 1,
      metadata: { title: 'Ch 2', kind: 'live', canStepTrack: true },
    });
    await vi.advanceTimersByTimeAsync(250);
    const statusesDuringZap = daemon
      .signals()
      .filter((s) => s.member === 'PropertiesChanged')
      .map((s) => (s.body[1] as Record<string, DbusVariant>)['PlaybackStatus']?.value)
      .filter(Boolean);
    expect(statusesDuringZap).toEqual(['Playing']);

    // New channel starts playing before 400ms -> Stopped never emitted!
    bridge.updateState({
      status: 'Playing',
      isNavigating: false,
      kind: 'live',
      positionUs: 0,
      durationUs: 0,
      rate: 1,
      volume: 1,
      metadata: { title: 'Ch 2', kind: 'live', canStepTrack: true },
    });
    await vi.advanceTimersByTimeAsync(500);
    const statusesAfterZap = daemon
      .signals()
      .filter((s) => s.member === 'PropertiesChanged')
      .map((s) => (s.body[1] as Record<string, DbusVariant>)['PlaybackStatus']?.value)
      .filter(Boolean);
    expect(statusesAfterZap).toEqual(['Playing']);

    // If zap stalls > 400ms, Stopped IS published after 400ms
    bridge.updateState({
      status: 'Stopped',
      isNavigating: true,
      kind: 'live',
      positionUs: 0,
      durationUs: 0,
      rate: 1,
      volume: 1,
      metadata: null,
    });
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => {
      const statuses = daemon
        .signals()
        .filter((s) => s.member === 'PropertiesChanged')
        .map((s) => (s.body[1] as Record<string, DbusVariant>)['PlaybackStatus']?.value)
        .filter(Boolean);
      expect(statuses).toEqual(['Playing', 'Stopped']);
    });

    bridge.dispose();
  });
});
