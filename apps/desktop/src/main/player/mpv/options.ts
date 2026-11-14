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
  '--save-position-on-quit=no',
  '--resume-playback=no',
  '--terminal=no',
  '--title=ELV IPTV',
  '--hwdec=auto-safe',
  '--network-timeout=10',
  '--curl-enabled=no',
];

/** Builds the full argv. Stream URLs and headers never appear here; they travel over IPC. */
export function launchArgs(p: {
  inputConf: string;
  presenterArgs: readonly string[];
  transportArgs: readonly string[];
}): string[] {
  return [...LAUNCH_OPTIONS, `--input-conf=${p.inputConf}`, ...p.presenterArgs, ...p.transportArgs];
}

const escapeField = (value: string): string => value.replace(/,/g, '\\,');

/** Maps request headers to mpv's `user-agent`, `referrer` and `http-header-fields` options. */
export function headerOptions(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  const rest: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'user-agent') out['user-agent'] = value;
    else if (lower === 'referer' || lower === 'referrer') out['referrer'] = value;
    else rest.push(escapeField(`${name}: ${value}`));
  }
  if (rest.length > 0) out['http-header-fields'] = rest.join(',');
  return out;
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
