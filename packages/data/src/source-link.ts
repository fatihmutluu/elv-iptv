import type { Result, TransportSettings } from '@elv/domain';
import { normalizeXtreamServer } from '@elv/sources';
import { type AddSourceDeps, addM3uSource, addXtreamSource, type SourceRecord } from './sources';

/** Credentials and server recognized in a pasted Xtream-shaped playlist link. */
export interface XtreamLink {
  server: string;
  username: string;
  password: string;
  output?: 'ts' | 'm3u8';
}

/** Input for {@link addSourceFromLink}. */
export interface LinkSourceInput {
  name: string;
  url: string;
  /** Skip the Xtream conversion and add the link as a plain M3U source. */
  keepAsM3u?: boolean;
  /** Guide override; stored whole as a secret for both kinds. An Xtream source falls back to the panel guide. */
  guideUrl?: string;
  /** M3U sources only; meaningless for an Xtream source and ignored there. */
  vodPlaylist?: boolean;
  transport?: TransportSettings;
}

const LINK = /^(https?:\/\/[^?#]*\/get\.php)\?([^#]*)/i;

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/**
 * Recognizes `…/get.php?username=…&password=…[&type=…&output=…]` (case-insensitive names, any parameter order,
 * encoded values); `undefined` otherwise. `output` is `m3u8` for `m3u8`/`hls`, `ts` for `ts`, absent otherwise.
 */
export function parseXtreamLink(url: string): XtreamLink | undefined {
  const m = LINK.exec(url.trim());
  if (m === null) return undefined;
  let username = '';
  let password = '';
  let output: XtreamLink['output'];
  for (const pair of (m[2] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).toLowerCase();
    const value = decode(pair.slice(eq + 1));
    if (name === 'username') username ||= value;
    else if (name === 'password') password ||= value;
    else if (name === 'output' && output === undefined) {
      const v = value.toLowerCase();
      if (v === 'm3u8' || v === 'hls') output = 'm3u8';
      else if (v === 'ts') output = 'ts';
    }
  }
  if (username === '' || password === '') return undefined;
  const link: XtreamLink = { server: normalizeXtreamServer(m[1] ?? ''), username, password };
  if (output !== undefined) link.output = output;
  return link;
}

/**
 * Adds an Xtream source when the link is Xtream-shaped (unless `keepAsM3u`), else an M3U source: on a real panel
 * the M3U cannot tell movies from live channels, while the Xtream API gives categories, movies, series and the guide.
 */
export async function addSourceFromLink(
  input: LinkSourceInput,
  deps: AddSourceDeps,
): Promise<Result<SourceRecord>> {
  const url = input.url.trim();
  const link = input.keepAsM3u === true ? undefined : parseXtreamLink(url);
  if (link === undefined) {
    return addM3uSource(
      {
        name: input.name,
        playlistUrl: url,
        ...(input.guideUrl === undefined ? {} : { guideUrl: input.guideUrl }),
        ...(input.vodPlaylist === undefined ? {} : { vodPlaylist: input.vodPlaylist }),
        ...(input.transport === undefined ? {} : { transport: input.transport }),
      },
      deps,
    );
  }
  const transport: TransportSettings | undefined =
    link.output === undefined ? input.transport : { ...input.transport, xtreamFormat: link.output };
  return addXtreamSource(
    {
      name: input.name,
      server: link.server,
      username: link.username,
      password: link.password,
      ...(input.guideUrl === undefined ? {} : { guideUrl: input.guideUrl }),
      ...(transport === undefined ? {} : { transport }),
    },
    deps,
  );
}
