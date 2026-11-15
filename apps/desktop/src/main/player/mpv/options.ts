import type { MediaKind } from '@elv/playback';
import type { MpvCommand } from './codec.ts';

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
  '--hwdec=auto-safe',
  '--network-timeout=10',
  '--curl-enabled=no',
  // The OSC paints a logo on the idle window before the first load; it is only reachable as a launch option.
  '--script-opts=osc-idlescreen=no',
];

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
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'user-agent') out['user-agent'] = value;
    else if (lower === 'referer' || lower === 'referrer') out['referrer'] = value;
  }
  return out;
}

/**
 * Maps custom request headers (excluding `User-Agent` and `Referer`/`Referrer`) to verbatim `Name: Value` entries
 * for `['set_property', 'http-header-fields', entries]` (`MPV_FORMAT_NODE_ARRAY`, avoiding mpv string-list escaping).
 */
export function headerFields(headers: Readonly<Record<string, string>>): string[] {
  const rest: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower !== 'user-agent' && lower !== 'referer' && lower !== 'referrer') {
      rest.push(`${name}: ${value}`);
    }
  }
  return rest;
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
      : { 'demuxer-max-bytes': '64MiB', 'demuxer-max-back-bytes': '16MiB' }),
  };
  if (r.startMs !== undefined) options['start'] = (r.startMs / 1000).toFixed(3);
  return ['loadfile', r.url, 'replace', -1, options];
}
