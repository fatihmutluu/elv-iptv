import type { Duplex } from 'node:stream';
import { type DesktopMediaMetadata, sanitizeDesktopArtworkUrl } from '../../shared/player-ipc.ts';
import type {
  DesktopMediaBridge,
  DesktopMediaCommand,
  DesktopMediaPlaybackStatus,
  DesktopMediaStateSnapshot,
} from '../media-bridge.ts';
import {
  createDbusClient,
  type DbusClient,
  type DbusMessage,
  type DbusVariant,
  dbusVariant,
  parseDbusSessionAddress,
} from './dbus-wire.ts';

const DBUS_SERVICE = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';
const DBUS_INTROSPECTABLE = 'org.freedesktop.DBus.Introspectable';
const DBUS_PROPERTIES = 'org.freedesktop.DBus.Properties';

const MPRIS_BUS_NAME = 'org.mpris.MediaPlayer2.elv_iptv';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_ROOT_IFACE = 'org.mpris.MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const DBUS_NAME_FLAG_DO_NOT_QUEUE = 0x4;
const DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER = 1;
const DBUS_REQUEST_NAME_REPLY_ALREADY_OWNER = 4;
const DEFAULT_NAVIGATING_DEBOUNCE_MS = 400;
const MIN_RATE = 0.25;
const MAX_RATE = 4.0;

const MPRIS_INTROSPECTION_XML = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node name="/org/mpris/MediaPlayer2">
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect">
      <arg name="xml_data" type="s" direction="out"/>
    </method>
  </interface>
  <interface name="org.freedesktop.DBus.Properties">
    <method name="Get">
      <arg name="interface_name" type="s" direction="in"/>
      <arg name="property_name" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="GetAll">
      <arg name="interface_name" type="s" direction="in"/>
      <arg name="properties" type="a{sv}" direction="out"/>
    </method>
    <method name="Set">
      <arg name="interface_name" type="s" direction="in"/>
      <arg name="property_name" type="s" direction="in"/>
      <arg name="value" type="v" direction="in"/>
    </method>
    <signal name="PropertiesChanged">
      <arg name="interface_name" type="s"/>
      <arg name="changed_properties" type="a{sv}"/>
      <arg name="invalidated_properties" type="as"/>
    </signal>
  </interface>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/>
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
    <property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Play"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Stop"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek">
      <arg name="Offset" type="x" direction="in"/>
    </method>
    <method name="SetPosition">
      <arg name="TrackId" type="o" direction="in"/>
      <arg name="Position" type="x" direction="in"/>
    </method>
    <signal name="Seeked">
      <arg name="Position" type="x"/>
    </signal>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Rate" type="d" access="readwrite"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="Position" type="x" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

/** Optional dependencies for {@link createMprisBridge}. */
export interface MprisBridgeOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injectable socket/stream factory passed through to {@link createDbusClient}. */
  readonly connect?: (socketPath: string) => Duplex;
  /** Injectable UID lookup for SASL `EXTERNAL` auth. */
  readonly getUid?: () => number;
  /** Callback invoked when an MPRIS2 client calls `Raise()`. */
  readonly onRaise?: () => void;
  /** Callback invoked when an MPRIS2 client calls `Quit()`. */
  readonly onQuit?: () => void;
  /** Debounce window (ms) to suppress transient `Stopped` flashes during channel zaps (default `400`). */
  readonly navigatingDebounceMs?: number;
  /** Optional diagnostic logger (never receives credentials). */
  readonly log?: (line: string) => void;
  /** Optional hook notified once `Hello` + `RequestName` succeed (useful in tests). */
  readonly onReady?: () => void;
}

interface PublishedPlayerProps {
  playbackStatus: DesktopMediaPlaybackStatus;
  rate: number;
  metadataKey: string;
  metadata: Record<string, DbusVariant>;
  volume: number;
  canGoNext: boolean;
  canGoPrevious: boolean;
  canPlay: boolean;
  canPause: boolean;
  canSeek: boolean;
}

const NOOP_BRIDGE: DesktopMediaBridge = {
  updateState: () => undefined,
  notifySeeked: () => undefined,
  onCommand: () => () => undefined,
  dispose: () => undefined,
};

function metadataIdentityKey(meta: DesktopMediaMetadata | null, kind: 'live' | 'vod'): string {
  if (!meta) return '';
  return `${kind}\0${meta.title}\0${meta.subtitle ?? ''}\0${meta.artworkUrl ?? ''}`;
}

function buildMprisMetadata(
  trackId: string,
  meta: DesktopMediaMetadata | null,
  status: DesktopMediaPlaybackStatus,
  kind: 'live' | 'vod',
  durationUs: number,
): Record<string, DbusVariant> {
  if (!meta && status === 'Stopped') return {};
  const title = meta?.title.trim() || 'ELV IPTV';
  const artist = meta?.subtitle?.trim() || 'ELV IPTV';
  const safeArt = sanitizeDesktopArtworkUrl(meta?.artworkUrl);
  const dict: Record<string, DbusVariant> = {
    'mpris:trackid': dbusVariant('o', trackId),
    'xesam:title': dbusVariant('s', title),
    'xesam:artist': dbusVariant('as', [artist]),
  };
  if (safeArt !== undefined) {
    dict['mpris:artUrl'] = dbusVariant('s', safeArt);
  }
  if (kind === 'vod' && durationUs > 0) {
    dict['mpris:length'] = dbusVariant('x', BigInt(Math.round(durationUs)));
  }
  return dict;
}

function serializeMetadataKey(dict: Record<string, DbusVariant>): string {
  const keys = Object.keys(dict).sort();
  return keys
    .map((k) => {
      const v = dict[k];
      const val = typeof v?.value === 'bigint' ? v.value.toString() : JSON.stringify(v?.value);
      return `${k}:${v?.signature ?? ''}=${val}`;
    })
    .join('|');
}

/**
 * Creates a Linux MPRIS2 D-Bus bridge (`#238`) exposing `/org/mpris/MediaPlayer2` under
 * `org.mpris.MediaPlayer2.elv_iptv` over `$DBUS_SESSION_BUS_ADDRESS` without any external npm
 * dependencies. Degrades silently to a no-op on non-Linux hosts or when D-Bus is unavailable.
 */
export function createMprisBridge(options?: MprisBridgeOptions): DesktopMediaBridge {
  const platform = options?.platform ?? process.platform;
  if (platform !== 'linux') return NOOP_BRIDGE;

  const env = options?.env ?? process.env;
  const socketPath = parseDbusSessionAddress(env['DBUS_SESSION_BUS_ADDRESS']);
  if (socketPath === null) return NOOP_BRIDGE;

  const debounceMs = Math.max(0, options?.navigatingDebounceMs ?? DEFAULT_NAVIGATING_DEBOUNCE_MS);
  const commandListeners = new Set<(cmd: DesktopMediaCommand) => void>();

  let client: DbusClient | undefined;
  let ready = false;
  let disposed = false;
  let trackCounter = 0;
  let currentTrackKey = '';
  let currentTrackId = '/org/mpris/MediaPlayer2/elv_iptv/track/0';
  let latestSnapshot: DesktopMediaStateSnapshot = {
    status: 'Stopped',
    isNavigating: false,
    kind: 'live',
    positionUs: 0,
    durationUs: 0,
    rate: 1,
    volume: 1,
    metadata: null,
  };
  let stopDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  let published: PublishedPlayerProps = {
    playbackStatus: 'Stopped',
    rate: 1,
    metadataKey: '',
    metadata: {},
    volume: 1,
    canGoNext: false,
    canGoPrevious: false,
    canPlay: false,
    canPause: false,
    canSeek: false,
  };

  const emitCommand = (cmd: DesktopMediaCommand): void => {
    if (disposed) return;
    for (const listener of [...commandListeners]) {
      try {
        listener(cmd);
      } catch {
        // isolate command subscribers
      }
    }
  };

  const clearDebounce = (): void => {
    if (stopDebounceTimer !== undefined) {
      clearTimeout(stopDebounceTimer);
      stopDebounceTimer = undefined;
    }
  };

  const computePlayerProps = (
    snap: DesktopMediaStateSnapshot,
    effectiveStatus: DesktopMediaPlaybackStatus,
  ): PublishedPlayerProps => {
    const idKey = metadataIdentityKey(snap.metadata, snap.kind);
    if (idKey.length > 0 && idKey !== currentTrackKey) {
      currentTrackKey = idKey;
      trackCounter += 1;
      currentTrackId = `/org/mpris/MediaPlayer2/elv_iptv/track/${trackCounter}`;
    } else if (idKey.length === 0 && effectiveStatus === 'Stopped') {
      currentTrackKey = '';
    }
    const metadata = buildMprisMetadata(
      currentTrackId,
      snap.metadata,
      effectiveStatus,
      snap.kind,
      snap.durationUs,
    );
    return {
      playbackStatus: effectiveStatus,
      rate: Number.isFinite(snap.rate) && snap.rate > 0 ? snap.rate : 1,
      metadataKey: serializeMetadataKey(metadata),
      metadata,
      volume: Number.isFinite(snap.volume) ? Math.max(0, Math.min(1, snap.volume)) : 1,
      canGoNext: snap.metadata?.canStepTrack === true,
      canGoPrevious: snap.metadata?.canStepTrack === true,
      canPlay: snap.metadata !== null || effectiveStatus !== 'Stopped',
      canPause: effectiveStatus === 'Playing' || effectiveStatus === 'Paused',
      canSeek: snap.kind === 'vod' && snap.durationUs > 0,
    };
  };

  const publishProps = (next: PublishedPlayerProps): void => {
    const changed: Record<string, DbusVariant> = {};
    if (next.playbackStatus !== published.playbackStatus) {
      changed['PlaybackStatus'] = dbusVariant('s', next.playbackStatus);
    }
    if (next.rate !== published.rate) {
      changed['Rate'] = dbusVariant('d', next.rate);
    }
    if (next.metadataKey !== published.metadataKey) {
      changed['Metadata'] = dbusVariant('a{sv}', next.metadata);
    }
    if (next.volume !== published.volume) {
      changed['Volume'] = dbusVariant('d', next.volume);
    }
    if (next.canGoNext !== published.canGoNext) {
      changed['CanGoNext'] = dbusVariant('b', next.canGoNext);
    }
    if (next.canGoPrevious !== published.canGoPrevious) {
      changed['CanGoPrevious'] = dbusVariant('b', next.canGoPrevious);
    }
    if (next.canPlay !== published.canPlay) {
      changed['CanPlay'] = dbusVariant('b', next.canPlay);
    }
    if (next.canPause !== published.canPause) {
      changed['CanPause'] = dbusVariant('b', next.canPause);
    }
    if (next.canSeek !== published.canSeek) {
      changed['CanSeek'] = dbusVariant('b', next.canSeek);
    }
    published = next;
    if (ready && client && Object.keys(changed).length > 0) {
      client.sendSignal({
        path: MPRIS_PATH,
        interface: DBUS_PROPERTIES,
        member: 'PropertiesChanged',
        signature: 'sa{sv}as',
        body: [MPRIS_PLAYER_IFACE, changed, []],
      });
    }
  };

  const rootProperties = (): Record<string, DbusVariant> => ({
    CanQuit: dbusVariant('b', typeof options?.onQuit === 'function'),
    CanRaise: dbusVariant('b', typeof options?.onRaise === 'function'),
    HasTrackList: dbusVariant('b', false),
    Identity: dbusVariant('s', 'ELV IPTV'),
    DesktopEntry: dbusVariant('s', 'elv-iptv'),
    SupportedUriSchemes: dbusVariant('as', []),
    SupportedMimeTypes: dbusVariant('as', []),
  });

  const playerProperties = (): Record<string, DbusVariant> => ({
    PlaybackStatus: dbusVariant('s', published.playbackStatus),
    Rate: dbusVariant('d', published.rate),
    Metadata: dbusVariant('a{sv}', published.metadata),
    Volume: dbusVariant('d', published.volume),
    Position: dbusVariant('x', BigInt(Math.max(0, Math.round(latestSnapshot.positionUs)))),
    MinimumRate: dbusVariant('d', MIN_RATE),
    MaximumRate: dbusVariant('d', MAX_RATE),
    CanGoNext: dbusVariant('b', published.canGoNext),
    CanGoPrevious: dbusVariant('b', published.canGoPrevious),
    CanPlay: dbusVariant('b', published.canPlay),
    CanPause: dbusVariant('b', published.canPause),
    CanSeek: dbusVariant('b', published.canSeek),
    CanControl: dbusVariant('b', true),
  });

  const handleMethodCall = (msg: DbusMessage): void => {
    if (!client || disposed) return;
    if (msg.path !== MPRIS_PATH) {
      client.sendError(
        msg.serial,
        msg.sender,
        'org.freedesktop.DBus.Error.UnknownObject',
        `Unknown object path: ${msg.path ?? ''}`,
      );
      return;
    }

    if (msg.interface === DBUS_INTROSPECTABLE && msg.member === 'Introspect') {
      client.sendReply(msg.serial, msg.sender, 's', [MPRIS_INTROSPECTION_XML]);
      return;
    }

    if (msg.interface === DBUS_PROPERTIES) {
      if (msg.member === 'Get') {
        const ifaceName = String(msg.body[0] ?? '');
        const propName = String(msg.body[1] ?? '');
        const map =
          ifaceName === MPRIS_ROOT_IFACE
            ? rootProperties()
            : ifaceName === MPRIS_PLAYER_IFACE
              ? playerProperties()
              : undefined;
        const val = map && Object.hasOwn(map, propName) ? map[propName] : undefined;
        if (!val) {
          client.sendError(
            msg.serial,
            msg.sender,
            'org.freedesktop.DBus.Error.UnknownProperty',
            `Unknown property ${ifaceName}.${propName}`,
          );
          return;
        }
        client.sendReply(msg.serial, msg.sender, 'v', [val]);
        return;
      }
      if (msg.member === 'GetAll') {
        const ifaceName = String(msg.body[0] ?? '');
        const map =
          ifaceName === MPRIS_ROOT_IFACE
            ? rootProperties()
            : ifaceName === MPRIS_PLAYER_IFACE
              ? playerProperties()
              : undefined;
        if (!map) {
          client.sendError(
            msg.serial,
            msg.sender,
            'org.freedesktop.DBus.Error.UnknownInterface',
            `Unknown interface ${ifaceName}`,
          );
          return;
        }
        client.sendReply(msg.serial, msg.sender, 'a{sv}', [map]);
        return;
      }
      if (msg.member === 'Set') {
        const ifaceName = String(msg.body[0] ?? '');
        const propName = String(msg.body[1] ?? '');
        const variant = msg.body[2] as DbusVariant | undefined;
        if (ifaceName === MPRIS_PLAYER_IFACE && propName === 'Rate') {
          const rate = Number(variant?.value);
          if (Number.isFinite(rate) && rate > 0) {
            emitCommand({ type: 'setRate', rate: Math.max(MIN_RATE, Math.min(MAX_RATE, rate)) });
          }
          client.sendReply(msg.serial, msg.sender, '', []);
          return;
        }
        if (ifaceName === MPRIS_PLAYER_IFACE && propName === 'Volume') {
          const volume = Number(variant?.value);
          if (Number.isFinite(volume)) {
            emitCommand({ type: 'setVolume', volume: Math.max(0, Math.min(1, volume)) });
          }
          client.sendReply(msg.serial, msg.sender, '', []);
          return;
        }
        client.sendError(
          msg.serial,
          msg.sender,
          'org.freedesktop.DBus.Error.PropertyReadOnly',
          `Property ${ifaceName}.${propName} is read-only`,
        );
        return;
      }
    }

    if (msg.interface === MPRIS_ROOT_IFACE) {
      if (msg.member === 'Raise') {
        options?.onRaise?.();
        client.sendReply(msg.serial, msg.sender, '', []);
        return;
      }
      if (msg.member === 'Quit') {
        options?.onQuit?.();
        client.sendReply(msg.serial, msg.sender, '', []);
        return;
      }
    }

    if (msg.interface === MPRIS_PLAYER_IFACE) {
      switch (msg.member) {
        case 'Play':
          emitCommand({ type: 'play' });
          client.sendReply(msg.serial, msg.sender, '', []);
          return;
        case 'Pause':
          emitCommand({ type: 'pause' });
          client.sendReply(msg.serial, msg.sender, '', []);
          return;
        case 'PlayPause':
          emitCommand({ type: 'togglePlayPause' });
          client.sendReply(msg.serial, msg.sender, '', []);
          return;
        case 'Stop':
          emitCommand({ type: 'stop' });
          client.sendReply(msg.serial, msg.sender, '', []);
          return;
        case 'Next':
          if (published.canGoNext) emitCommand({ type: 'next' });
          client.sendReply(msg.serial, msg.sender, '', []);
          return;
        case 'Previous':
          if (published.canGoPrevious) emitCommand({ type: 'previous' });
          client.sendReply(msg.serial, msg.sender, '', []);
          return;
        case 'Seek': {
          const offsetUs = Number(msg.body[0] ?? 0);
          if (published.canSeek && Number.isFinite(offsetUs)) {
            emitCommand({ type: 'seekByUs', offsetUs });
          }
          client.sendReply(msg.serial, msg.sender, '', []);
          return;
        }
        case 'SetPosition': {
          const trackId = String(msg.body[0] ?? '');
          const positionUs = Number(msg.body[1] ?? 0);
          if (
            published.canSeek &&
            trackId === currentTrackId &&
            Number.isFinite(positionUs) &&
            positionUs >= 0
          ) {
            emitCommand({ type: 'seekToUs', positionUs });
          }
          client.sendReply(msg.serial, msg.sender, '', []);
          return;
        }
      }
    }

    client.sendError(
      msg.serial,
      msg.sender,
      'org.freedesktop.DBus.Error.UnknownMethod',
      `Unknown method ${msg.interface ?? ''}.${msg.member ?? ''}`,
    );
  };

  const dbus = createDbusClient({
    socketPath,
    ...(options?.connect !== undefined ? { connect: options.connect } : {}),
    ...(options?.getUid !== undefined ? { getUid: options.getUid } : {}),
  });
  client = dbus;
  dbus.onMethodCall(handleMethodCall);
  dbus.onClose(() => {
    ready = false;
  });

  const requestBusName = async (busName: string): Promise<boolean> => {
    const reply = await dbus.call({
      destination: DBUS_SERVICE,
      path: DBUS_PATH,
      interface: DBUS_IFACE,
      member: 'RequestName',
      signature: 'su',
      body: [busName, DBUS_NAME_FLAG_DO_NOT_QUEUE],
    });
    const code = reply.body[0];
    return (
      code === DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER ||
      code === DBUS_REQUEST_NAME_REPLY_ALREADY_OWNER
    );
  };

  void dbus
    .connect()
    .then(() =>
      dbus.call({
        destination: DBUS_SERVICE,
        path: DBUS_PATH,
        interface: DBUS_IFACE,
        member: 'Hello',
      }),
    )
    .then(async () => {
      if (await requestBusName(MPRIS_BUS_NAME)) return;
      const fallbackName = `${MPRIS_BUS_NAME}.instance${process.pid}`;
      if (await requestBusName(fallbackName)) return;
      throw new Error(`RequestName declined for ${MPRIS_BUS_NAME} and ${fallbackName}`);
    })
    .then(() => {
      if (disposed) return;
      ready = true;
      options?.onReady?.();
    })
    .catch((err: unknown) => {
      ready = false;
      if (!disposed) {
        const msg = err instanceof Error ? err.message : String(err);
        options?.log?.(`mpris: unavailable (${msg})`);
        dbus.close();
      }
    });

  return {
    updateState(snapshot) {
      if (disposed) return;
      latestSnapshot = { ...snapshot };
      if (
        snapshot.status === 'Stopped' &&
        snapshot.isNavigating &&
        published.playbackStatus !== 'Stopped'
      ) {
        if (stopDebounceTimer === undefined) {
          stopDebounceTimer = setTimeout(() => {
            stopDebounceTimer = undefined;
            if (disposed || latestSnapshot.status !== 'Stopped') return;
            publishProps(computePlayerProps(latestSnapshot, 'Stopped'));
          }, debounceMs);
        }
        publishProps(computePlayerProps(snapshot, published.playbackStatus));
        return;
      }
      clearDebounce();
      publishProps(computePlayerProps(snapshot, snapshot.status));
    },
    notifySeeked(positionUs) {
      if (disposed || !ready || !client) return;
      if (!Number.isFinite(positionUs)) return;
      const clampedUs = Math.max(0, Math.round(positionUs));
      latestSnapshot = { ...latestSnapshot, positionUs: clampedUs };
      client.sendSignal({
        path: MPRIS_PATH,
        interface: MPRIS_PLAYER_IFACE,
        member: 'Seeked',
        signature: 'x',
        body: [BigInt(clampedUs)],
      });
    },
    onCommand(listener) {
      if (disposed) return () => undefined;
      commandListeners.add(listener);
      return () => {
        commandListeners.delete(listener);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ready = false;
      clearDebounce();
      commandListeners.clear();
      client?.close();
      client = undefined;
    },
  };
}
