import { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createDbusClient,
  DBUS_MSG_TYPE,
  type DbusMessage,
  DbusRemoteError,
  dbusVariant,
  encodeDbusMessage,
  parseDbusSessionAddress,
  splitCompleteTypes,
  tryDecodeDbusMessage,
} from './dbus-wire.ts';

function createDuplexPair(): { clientEnd: Duplex; serverEnd: Duplex } {
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
  return { clientEnd, serverEnd };
}

describe('parseDbusSessionAddress', () => {
  it('parses valid unix:path addresses including percent-encoding and multi-entry lists', () => {
    expect(parseDbusSessionAddress('unix:path=/run/user/1000/bus')).toBe('/run/user/1000/bus');
    expect(parseDbusSessionAddress('unix:path=/tmp/my%20bus/sock,guid=1234')).toBe(
      '/tmp/my bus/sock',
    );
    expect(
      parseDbusSessionAddress('tcp:host=127.0.0.1,port=1234;unix:path=/run/user/1000/bus'),
    ).toBe('/run/user/1000/bus');
  });

  it('rejects missing, non-unix, abstract, control-char, or malformed addresses', () => {
    expect(parseDbusSessionAddress(undefined)).toBeNull();
    expect(parseDbusSessionAddress('')).toBeNull();
    expect(parseDbusSessionAddress('tcp:host=127.0.0.1,port=5555')).toBeNull();
    expect(parseDbusSessionAddress('unix:abstract=/tmp/dbus-abc')).toBeNull();
    expect(parseDbusSessionAddress('unix:path=relative/sock')).toBeNull();
    expect(parseDbusSessionAddress('unix:path=/run/user/1000/bus%00evil')).toBeNull();
    expect(parseDbusSessionAddress('unix:path=/run/user/1000/bus%ZZ')).toBeNull();
    expect(parseDbusSessionAddress(`unix:path=/${'a'.repeat(300)}`)).toBeNull();
  });
});

describe('splitCompleteTypes', () => {
  it('splits primitive, array, dict, and struct D-Bus signatures', () => {
    expect(splitCompleteTypes('sa{sv}as')).toEqual(['s', 'a{sv}', 'as']);
    expect(splitCompleteTypes('ox')).toEqual(['o', 'x']);
    expect(splitCompleteTypes('a(yv)')).toEqual(['a(yv)']);
    expect(() => splitCompleteTypes('a')).toThrow();
    expect(() => splitCompleteTypes('(ss')).toThrow();
    expect(() => splitCompleteTypes('z')).toThrow();
  });
});

describe('encodeDbusMessage / tryDecodeDbusMessage', () => {
  it('round-trips every supported D-Bus type including nested variants, dicts, and empty arrays with 8-byte alignment', () => {
    const msg: DbusMessage = {
      type: DBUS_MSG_TYPE.SIGNAL,
      flags: 0,
      serial: 42,
      path: '/org/mpris/MediaPlayer2',
      interface: 'org.freedesktop.DBus.Properties',
      member: 'PropertiesChanged',
      signature: 'sa{sv}as',
      body: [
        'org.mpris.MediaPlayer2.Player',
        {
          PlaybackStatus: dbusVariant('s', 'Playing'),
          Rate: dbusVariant('d', 1.25),
          CanSeek: dbusVariant('b', true),
          Position: dbusVariant('x', 12_345_678n),
          Flags: dbusVariant('u', 4),
          Delta: dbusVariant('i', -10),
          Metadata: dbusVariant('a{sv}', {
            'mpris:trackid': dbusVariant('o', '/org/mpris/MediaPlayer2/elv_iptv/track/1'),
            'xesam:title': dbusVariant('s', 'Channel One — HD'),
            'xesam:artist': dbusVariant('as', ['Evening News']),
            'mpris:length': dbusVariant('x', 3_600_000_000n),
          }),
          EmptyDict: dbusVariant('a{sv}', {}),
        },
        ['Volume'],
      ],
    };

    const wire = encodeDbusMessage(msg);
    expect(tryDecodeDbusMessage(wire.subarray(0, 10))).toBeNull();
    expect(tryDecodeDbusMessage(wire.subarray(0, wire.length - 1))).toBeNull();

    const decoded = tryDecodeDbusMessage(wire);
    expect(decoded).not.toBeNull();
    expect(decoded?.bytesRead).toBe(wire.length);
    expect(decoded?.message).toEqual(msg);
  });

  it('handles empty a{sv} following a 4-byte-aligned field (verifying mandatory element alignment padding)', () => {
    const msg: DbusMessage = {
      type: DBUS_MSG_TYPE.METHOD_RETURN,
      flags: 0,
      serial: 7,
      replySerial: 3,
      signature: 'ua{sv}u',
      body: [1, {}, 99],
    };
    const wire = encodeDbusMessage(msg);
    const decoded = tryDecodeDbusMessage(wire);
    expect(decoded?.message.body).toEqual([1, {}, 99]);
  });

  it('round-trips int16 (n) and uint16 (q) with 2-byte alignment and rejects malformed or deeply nested variants', () => {
    const msg: DbusMessage = {
      type: DBUS_MSG_TYPE.METHOD_RETURN,
      flags: 0,
      serial: 8,
      replySerial: 4,
      signature: 'ynqv',
      body: [7, -12345, 54321, dbusVariant('n', -32768)],
    };
    const wire = encodeDbusMessage(msg);
    const decoded = tryDecodeDbusMessage(wire);
    expect(decoded?.message.body).toEqual([7, -12345, 54321, dbusVariant('n', -32768)]);

    // Multi-type variant signature ('ss') is rejected cleanly instead of desyncing framing
    const badVariantHeader = encodeDbusMessage({
      type: DBUS_MSG_TYPE.METHOD_CALL,
      flags: 0,
      serial: 9,
      path: '/org/mpris/MediaPlayer2',
      interface: 'org.freedesktop.DBus.Properties',
      member: 'Set',
      signature: 'v',
      body: [dbusVariant('s', 'ok')],
    });
    // Replace body (signature 's' + string 'ok') with malformed variant signature 'ss'
    const headerLen = badVariantHeader.length - (1 + 1 + 1 + 1 + 4 + 3);
    const badBody = Buffer.from([2, 0x73, 0x73, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const badFrame = Buffer.concat([badVariantHeader.subarray(0, headerLen), badBody]);
    badFrame.writeUInt32LE(badBody.length, 4);
    expect(() => tryDecodeDbusMessage(badFrame)).toThrow(/variant signature/i);

    // Deeply nested variants (> 16 levels) throw a clean nesting error instead of stack-overflowing
    let nested = dbusVariant('u', 1);
    for (let i = 0; i < 20; i += 1) {
      nested = dbusVariant('v', nested);
    }
    const deepWire = encodeDbusMessage({
      type: DBUS_MSG_TYPE.METHOD_RETURN,
      flags: 0,
      serial: 10,
      replySerial: 5,
      signature: 'v',
      body: [nested],
    });
    expect(() => tryDecodeDbusMessage(deepWire)).toThrow(/nesting too deep/i);
  });
});

describe('createDbusClient', () => {
  it('completes EXTERNAL SASL auth (including fragmented chunks), exchanges METHOD_CALL/RETURN/ERROR, and dispatches inbound calls', async () => {
    const { clientEnd, serverEnd } = createDuplexPair();
    const receivedAuth: Buffer[] = [];
    const serverMessages: DbusMessage[] = [];
    let authDone = false;
    let serverRx: Buffer = Buffer.alloc(0);

    serverEnd.on('data', (chunk: Buffer) => {
      serverRx = Buffer.concat([serverRx, chunk]);
      if (!authDone) {
        const idx = serverRx.indexOf('BEGIN\r\n');
        const authLineEnd = serverRx.indexOf('\r\n');
        if (authLineEnd !== -1 && receivedAuth.length === 0) {
          receivedAuth.push(serverRx.subarray(0, authLineEnd + 2));
          serverRx = serverRx.subarray(authLineEnd + 2);
          // Send OK in two fragmented chunks to test line buffering
          serverEnd.write('OK 01234567');
          serverEnd.write('89abcdef\r\n');
          return;
        }
        if (idx !== -1) {
          authDone = true;
          serverRx = serverRx.subarray(idx + 'BEGIN\r\n'.length);
        }
      }
      if (authDone) {
        while (serverRx.length >= 16) {
          const decoded = tryDecodeDbusMessage(serverRx);
          if (!decoded) break;
          serverRx = serverRx.subarray(decoded.bytesRead);
          serverMessages.push(decoded.message);
          const m = decoded.message;
          if (m.type === DBUS_MSG_TYPE.METHOD_CALL && m.member === 'Hello') {
            serverEnd.write(
              encodeDbusMessage({
                type: DBUS_MSG_TYPE.METHOD_RETURN,
                flags: 0,
                serial: 100,
                replySerial: m.serial,
                signature: 's',
                body: [':1.42'],
              }),
            );
          } else if (m.type === DBUS_MSG_TYPE.METHOD_CALL && m.member === 'Boom') {
            serverEnd.write(
              encodeDbusMessage({
                type: DBUS_MSG_TYPE.ERROR,
                flags: 0,
                serial: 101,
                replySerial: m.serial,
                errorName: 'org.freedesktop.DBus.Error.Failed',
                signature: 's',
                body: ['synthetic failure'],
              }),
            );
          }
        }
      }
    });

    const client = createDbusClient({
      socketPath: '/run/user/1000/bus',
      connect: () => clientEnd,
      getUid: () => 1000,
    });
    const inbound: DbusMessage[] = [];
    client.onMethodCall((m) => inbound.push(m));

    await client.connect();
    // NUL byte + "AUTH EXTERNAL 31303030\r\n" (hex of "1000")
    expect(receivedAuth[0]?.equals(Buffer.from('\0AUTH EXTERNAL 31303030\r\n', 'ascii'))).toBe(
      true,
    );

    const helloReply = await client.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus',
      member: 'Hello',
    });
    expect(helloReply.body).toEqual([':1.42']);

    await expect(
      client.call({
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'Boom',
      }),
    ).rejects.toThrow(DbusRemoteError);

    // Inbound METHOD_CALL from peer arrives on methodCall listener
    serverEnd.write(
      encodeDbusMessage({
        type: DBUS_MSG_TYPE.METHOD_CALL,
        flags: 0,
        serial: 55,
        sender: ':1.99',
        path: '/org/mpris/MediaPlayer2',
        interface: 'org.mpris.MediaPlayer2.Player',
        member: 'PlayPause',
        body: [],
      }),
    );
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    expect(inbound[0]?.member).toBe('PlayPause');

    const closed = vi.fn();
    client.onClose(closed);
    client.close();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('rejects connect cleanly when SASL EXTERNAL auth is rejected', async () => {
    const { clientEnd, serverEnd } = createDuplexPair();
    serverEnd.on('data', () => {
      serverEnd.write('REJECTED EXTERNAL\r\n');
    });
    const client = createDbusClient({
      socketPath: '/run/user/1000/bus',
      connect: () => clientEnd,
      getUid: () => 1000,
    });
    await expect(client.connect()).rejects.toThrow(/REJECTED/);
  });
});
