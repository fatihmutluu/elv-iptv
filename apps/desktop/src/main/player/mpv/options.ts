import type { MediaKind } from '@elv/playback';
import type { MpvCommand } from './codec.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional HTTP header control-char stripper
const HEADER_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Options every mpv launch carries, in order, without `--input-conf` (see `launchArgs`). */
export const LAUNCH_OPTIONS: readonly string[] = [
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
  '--cache-on-disk=no',
  '--demuxer-donate-buffer=no',
  '--autoload-files=no',
  '--tls-verify=yes',
  '--stream-lavf-o=icy=0,reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5',
  '--reset-on-next-file=aid,sid,vid,sub-visibility,audio-delay,sub-delay,video-aspect-override,deinterlace,speed,panscan,keepaspect,video-unscaled,gamma,brightness,contrast,saturation',
  '--network-timeout=10',
  '--curl-enabled=no',
  '--osc=no',
  '--osd-level=0',
  '--input-default-bindings=no',
];

function stripControlChars(value: string): string {
  return value.replace(HEADER_CONTROL_CHARS, '');
}

/**
 * Builds the full argv. Stream URLs and headers never appear here; they travel over IPC.
 * Our macOS runtime is built without libcurl, so `--curl-enabled` does not exist there.
 */
export function launchArgs(p: {
  inputConf: string;
  presenterArgs: readonly string[];
  transportArgs: readonly string[];
  platform?: string;
}): string[] {
  const base =
    p.platform === 'darwin'
      ? LAUNCH_OPTIONS.filter((o) => o !== '--curl-enabled=no')
      : LAUNCH_OPTIONS;
  return [...base, `--input-conf=${p.inputConf}`, ...p.presenterArgs, ...p.transportArgs];
}

/** Maps `User-Agent` and `Referer`/`Referrer` headers to mpv's per-file `loadfile` options. */
export function headerOptions(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const lower = stripControlChars(rawName).trim().toLowerCase();
    const cleanValue = stripControlChars(rawValue);
    if (lower === 'user-agent') out['user-agent'] = cleanValue;
    else if (lower === 'referer' || lower === 'referrer') out['referrer'] = cleanValue;
  }
  return out;
}

/**
 * Maps custom request headers (excluding `User-Agent` and `Referer`/`Referrer`) to deduplicated `Name: Value` entries
 * for `['set_property', 'http-header-fields', entries]` (`MPV_FORMAT_NODE_ARRAY`, avoiding mpv string-list escaping).
 */
export function headerFields(headers: Readonly<Record<string, string>>): string[] {
  const deduplicated = new Map<string, { name: string; value: string }>();
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = stripControlChars(rawName).replace(/:/g, '').trim();
    if (name === '') continue;
    const lower = name.toLowerCase();
    if (lower === 'user-agent' || lower === 'referer' || lower === 'referrer') continue;
    deduplicated.set(lower, { name, value: stripControlChars(rawValue) });
  }
  return Array.from(deduplicated.values(), ({ name, value }) => `${name}: ${value}`);
}

/** Builds the `loadfile` command that replaces the current media; all option values are strings. */
export function loadfileCommand(r: {
  url: string;
  headers: Readonly<Record<string, string>>;
  kind: MediaKind;
  startMs?: number;
}): MpvCommand {
  const options: Record<string, string> = {
    ...headerOptions(r.headers),
    ...(r.kind === 'live'
      ? { 'demuxer-max-bytes': '32MiB', 'demuxer-max-back-bytes': '0' }
      : {
          'demuxer-max-bytes': '64MiB',
          'demuxer-max-back-bytes': '16MiB',
          'demuxer-hysteresis-secs': '10',
        }),
  };
  if (r.startMs !== undefined) options['start'] = (r.startMs / 1000).toFixed(3);
  return ['loadfile', r.url, 'replace', -1, options];
}
