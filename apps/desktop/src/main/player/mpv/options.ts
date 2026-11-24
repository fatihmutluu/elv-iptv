import type { SubtitleStyleConfig } from '@elv/domain';
import type { MediaKind } from '@elv/playback';
import type { DeinterlaceMode, HwdecProfile } from '../../../shared/player-ipc.ts';
import type { MpvCommand } from './codec.ts';
import { DEFAULT_SECONDARY_SUB_POS, subtitleStyleLoadOptions } from './subtitle-style.ts';

/** Labeled mpv video filter for broadcast-grade `bwdif` deinterlacing (`#243`). */
export const DEINTERLACE_BWDIF_FILTER =
  '@elv_deint:lavfi=[bwdif=mode=send_frame:parity=auto:deint=interlaced]';

/** Labeled mpv audio filter for EBU R128 loudness normalization (`#243`). */
export const LOUDNORM_FILTER = '@elv_loudnorm:lavfi=[loudnorm=I=-16:TP=-1.5:LRA=11]';

/** Builds the mpv commands for a {@link DeinterlaceMode} without clobbering unrelated `vf` entries (`#243`). */
export function deinterlaceCommands(mode: DeinterlaceMode): readonly MpvCommand[] {
  switch (mode) {
    case 'off':
      return [
        ['set_property', 'deinterlace', 'no'],
        ['vf', 'remove', '@elv_deint'],
      ];
    case 'auto':
      return [
        ['set_property', 'deinterlace', 'auto'],
        ['vf', 'remove', '@elv_deint'],
      ];
    case 'bwdif':
      return [
        ['set_property', 'deinterlace', 'no'],
        ['vf', 'add', DEINTERLACE_BWDIF_FILTER],
      ];
  }
}

/** Builds the mpv `audio-pitch-correction` (`scaletempo2`) property command (`#243`). */
export function pitchLockCommand(locked: boolean): MpvCommand {
  return ['set_property', 'audio-pitch-correction', locked ? 'yes' : 'no'];
}

/** Builds the labeled `@elv_loudnorm` `af` add/remove command (`#243`). */
export function audioNormalizationCommand(enabled: boolean): MpvCommand {
  return enabled ? ['af', 'add', LOUDNORM_FILTER] : ['af', 'remove', '@elv_loudnorm'];
}

/** Returns whether an `audio-spdif` property value indicates active S/PDIF/HDMI bitstream passthrough. */
export function isSpdifPassthroughValue(value: unknown): boolean {
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    return trimmed.length > 0 && trimmed !== 'no' && trimmed !== 'none';
  }
  if (Array.isArray(value)) {
    return value.some(
      (v) =>
        typeof v === 'string' &&
        v.trim().length > 0 &&
        v.trim().toLowerCase() !== 'no' &&
        v.trim().toLowerCase() !== 'none',
    );
  }
  return false;
}

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
  '--demuxer-lavf-probe-info=yes',
  '--cache-on-disk=no',
  '--demuxer-donate-buffer=no',
  '--autoload-files=no',
  '--prefetch-playlist=no',
  '--audio-pitch-correction=yes',
  '--tls-verify=yes',
  '--stream-lavf-o=icy=0,reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5',
  '--reset-on-next-file=aid,sid,secondary-sid,secondary-sub-pos,vid,sub-visibility,audio-delay,sub-delay,video-aspect-override,deinterlace,speed,panscan,keepaspect,video-unscaled,gamma,brightness,contrast,saturation',
  '--network-timeout=10',
  '--curl-enabled=no',
  '--osc=no',
  '--osd-level=0',
  '--input-default-bindings=no',
];

function stripControlChars(value: string): string {
  return value.replace(HEADER_CONTROL_CHARS, '');
}

function hwdecFlags(hwdec: HwdecProfile, platform?: string): string[] {
  if (hwdec === 'darwin-compat') {
    return platform === 'darwin'
      ? ['--hwdec=auto-safe', '--hwdec-image-format=uyvy422']
      : ['--hwdec=auto-safe'];
  }
  return [`--hwdec=${hwdec}`];
}

/**
 * Builds the full argv. Stream URLs and headers never appear here; they travel over IPC.
 * Our macOS runtime is built without libcurl, so `--curl-enabled` does not exist there.
 * Linux adds `--pulse-buffer=50` (#269); render-context mode (#210, #95) switches to
 * `--force-window=no`, `--vo=libmpv`, and `--video-timing-offset=0`.
 */
export function launchArgs(p: {
  inputConf: string;
  presenterArgs: readonly string[];
  transportArgs: readonly string[];
  platform?: string;
  hwdec?: HwdecProfile;
  renderContext?: boolean;
  fontsDir?: string;
}): string[] {
  const profile = p.hwdec ?? 'auto-safe';
  const base = LAUNCH_OPTIONS.flatMap((opt) => {
    if (p.platform === 'darwin' && opt === '--curl-enabled=no') return [];
    if (opt === '--hwdec=auto-safe') return hwdecFlags(profile, p.platform);
    if (p.renderContext === true && opt === '--force-window=immediate') {
      return ['--force-window=no'];
    }
    return [opt];
  });
  const extra: string[] = [];
  if (p.platform === 'linux') extra.push('--pulse-buffer=50');
  if (p.renderContext === true) extra.push('--vo=libmpv', '--video-timing-offset=0');
  if (p.fontsDir !== undefined && p.fontsDir.length > 0) {
    extra.push(`--sub-fonts-dir=${p.fontsDir}`);
  }
  return [...base, ...extra, `--input-conf=${p.inputConf}`, ...p.presenterArgs, ...p.transportArgs];
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

/** Builds the `loadfile` command that replaces or appends media; all option values are strings (`#205`). */
export function loadfileCommand(
  r: {
    url: string;
    headers: Readonly<Record<string, string>>;
    kind: MediaKind;
    startMs?: number;
    preferHevcOverDolbyVision?: boolean;
    filterSdhSubtitles?: boolean;
    subtitleStyle?: SubtitleStyleConfig;
    secondarySubtitleActive?: boolean;
  },
  mode: 'replace' | 'append-play' = 'replace',
): MpvCommand {
  const options: Record<string, string> = {
    ...headerOptions(r.headers),
    ...(r.kind === 'live'
      ? { 'demuxer-max-bytes': '32MiB', 'demuxer-max-back-bytes': '128MiB' }
      : {
          'demuxer-max-bytes': '64MiB',
          'demuxer-max-back-bytes': '16MiB',
          'demuxer-hysteresis-secs': '10',
        }),
    'secondary-sub-pos': String(DEFAULT_SECONDARY_SUB_POS),
    ...(r.subtitleStyle === undefined
      ? {}
      : subtitleStyleLoadOptions(r.subtitleStyle, r.secondarySubtitleActive === true)),
  };
  if (r.startMs !== undefined) options['start'] = (r.startMs / 1000).toFixed(3);
  if (r.preferHevcOverDolbyVision === true) options['hwdec'] = 'no';
  if (r.filterSdhSubtitles !== undefined) {
    options['sub-filter-sdh'] = r.filterSdhSubtitles ? 'yes' : 'no';
  }
  return ['loadfile', r.url, mode, -1, options];
}
