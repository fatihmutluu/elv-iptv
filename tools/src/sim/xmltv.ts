import { type Catalog, rng } from './catalog.ts';

/** One guide entry of a channel. */
export interface Programme {
  channel: string;
  start: Date;
  stop: Date;
  title: string;
  desc: string;
  category: string;
  episode: string | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CHUNK_LIMIT = 65_536;
const LENGTHS_MIN = [30, 60, 90] as const;
const CATEGORIES = ['News', 'Sports', 'Drama', 'Comedy', 'Music', 'Nature'] as const;
const COMPAT_OFFSETS = [0, 180, -300] as const;
const NAME_ONLY = 'name-only';
const UNKNOWN = 'unknown-channel';
const DUP = 'dup';

/** Formats an XMLTV time such as `20260101000000 +0000` for the given offset in minutes. */
export function xmltvTime(date: Date, offsetMinutes: number): string {
  const d = new Date(date.getTime() + offsetMinutes * 60_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const abs = Math.abs(offsetMinutes);
  const sign = offsetMinutes < 0 ? '-' : '+';
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} ${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

function windowBounds(catalog: Catalog, now: Date): { from: number; to: number } {
  return {
    from: Math.floor((now.getTime() - catalog.guideWindow.daysBack * DAY) / HOUR) * HOUR,
    to: now.getTime() + catalog.guideWindow.daysForward * DAY,
  };
}

function dayStream(seed: number, channelIndex: number, day: number): () => number {
  const mixed =
    Math.imul(seed, 0x9e3779b1) ^
    Math.imul(channelIndex + 1, 0x85ebca6b) ^
    Math.imul(day + 1, 0xc2b2ae35);
  return rng(mixed);
}

/**
 * Each UTC day is scheduled on its own from midnight with a stream seeded by (seed, channel, day), so a
 * programme never moves when the window slides. The last programme of a day is cut at midnight.
 */
function* generate(
  catalog: Catalog,
  channel: string,
  channelIndex: number,
  now: Date,
): Generator<Programme> {
  const { from, to } = windowBounds(catalog, now);
  for (let day = Math.floor(from / DAY); day * DAY < to; day++) {
    const next = dayStream(catalog.seed, channelIndex, day);
    const dayEnd = (day + 1) * DAY;
    let at = day * DAY;
    for (let n = 1; at < dayEnd; n++) {
      const minutes = LENGTHS_MIN[Math.floor(next() * LENGTHS_MIN.length)] as number;
      const category = CATEGORIES[Math.floor(next() * CATEGORIES.length)] as string;
      const stop = Math.min(at + minutes * 60_000, dayEnd);
      if (stop > from && at < to) {
        yield {
          channel,
          start: new Date(at),
          stop: new Date(stop),
          title: `Programme ${n}`,
          desc: `Description of programme ${n} on ${channel}.`,
          category,
          episode: n % 3 === 0 ? `S${(n % 4) + 1} E${(n % 20) + 1}` : null,
        };
      }
      at = stop;
    }
  }
}

/** Programmes of one channel inside the window around `now`, deterministic per seed. */
export function* programmesFor(
  catalog: Catalog,
  channelIndex: number,
  now: Date,
): Generator<Programme> {
  const epgId = catalog.live[channelIndex]?.epgId;
  if (epgId) yield* generate(catalog, epgId, channelIndex, now);
}

const esc = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escAttr = (s: string): string => esc(s).replaceAll('"', '&quot;');

function programmeXml(p: Programme, offset: number, rawDesc = false): string {
  const desc = rawDesc ? `<![CDATA[${p.desc}]]>` : esc(p.desc);
  const episode =
    p.episode === null ? '' : `<episode-num system="onscreen">${esc(p.episode)}</episode-num>`;
  return `<programme start="${xmltvTime(p.start, offset)}" stop="${xmltvTime(p.stop, offset)}" channel="${escAttr(p.channel)}"><title>${esc(p.title)}</title><desc>${desc}</desc><category>${esc(p.category)}</category>${episode}</programme>\n`;
}

interface GuideChannel {
  id: string;
  name: string;
  logo: number | null;
  index: number;
  offset: number;
}

function guideChannels(catalog: Catalog): GuideChannel[] {
  const compat = catalog.profile === 'compat';
  const out: GuideChannel[] = [];
  catalog.live.forEach((ch, index) => {
    if (ch.epgId === null) return;
    const offset = compat ? (COMPAT_OFFSETS[index % COMPAT_OFFSETS.length] as number) : 0;
    out.push({ id: ch.epgId, name: ch.name, logo: ch.logo, index, offset });
  });
  if (compat) {
    const noId = catalog.live.find((c) => c.compat === 'no-tvg-id');
    const n = catalog.live.length;
    out.push({ id: DUP, name: 'Duplicate Id Guide', logo: null, index: n, offset: 0 });
    out.push({
      id: NAME_ONLY,
      name: noId?.name ?? 'Name Only',
      logo: null,
      index: n + 1,
      offset: 180,
    });
    out.push({ id: UNKNOWN, name: 'Unknown Channel', logo: null, index: n + 2, offset: -300 });
  }
  return out;
}

function programme(
  channel: string,
  start: number,
  minutes: number,
  title: string,
  desc: string,
): Programme {
  return {
    channel,
    start: new Date(start),
    stop: new Date(start + minutes * 60_000),
    title,
    desc,
    category: 'Drama',
    episode: null,
  };
}

/** Hand-written compat programmes on the `dup` channel: overlap, entities, CDATA, midnight. */
function* compatSpecials(now: Date): Generator<string> {
  const day = Math.floor(now.getTime() / DAY) * DAY;
  const a = programme(DUP, day + 10 * HOUR, 60, 'Overlap A', 'Starts first.');
  const b = programme(DUP, day + 10.5 * HOUR, 60, 'Overlap B', 'Starts inside A.');
  const entities = programme(DUP, day + 12 * HOUR, 60, 'Salt & Pepper', 'Under <5 minutes & more.');
  const cdata = programme(DUP, day + 13 * HOUR, 60, 'Raw Text', 'Uses <b>markup</b> & raw text.');
  const midnight = programme(DUP, day + 23.5 * HOUR, 60, 'Midnight Show', 'Crosses midnight.');
  yield programmeXml(a, 0);
  yield programmeXml(b, 0);
  yield programmeXml(entities, 0);
  yield programmeXml(cdata, 0, true);
  yield programmeXml(midnight, 0);
}

/** Malformed trailing programmes: one without `stop`, one with an unclosed `<title>`. */
function* compatBroken(now: Date): Generator<string> {
  const start = xmltvTime(new Date(Math.floor(now.getTime() / DAY) * DAY + 6 * HOUR), -300);
  yield `<programme start="${start}" channel="${UNKNOWN}"><title>No Stop</title><desc>Missing stop.</desc></programme>\n`;
  yield `<programme start="${start}" stop="${start}" channel="${UNKNOWN}"><title>Unclosed title</programme>\n`;
}

function* documentPieces(catalog: Catalog, now: Date, baseUrl: string): Generator<string> {
  const channels = guideChannels(catalog);
  const compat = catalog.profile === 'compat';
  yield '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="elv-sim">\n';
  for (const ch of channels) {
    const icon = ch.logo === null ? '' : `<icon src="${baseUrl}/logos/${ch.logo}.png"/>`;
    yield `<channel id="${escAttr(ch.id)}"><display-name>${esc(ch.name)}</display-name>${icon}</channel>\n`;
  }
  for (const ch of channels) {
    for (const p of generate(catalog, ch.id, ch.index, now)) yield programmeXml(p, ch.offset);
    if (ch.id === DUP) yield* compatSpecials(now);
  }
  if (compat) yield* compatBroken(now);
  yield '</tv>\n';
}

/**
 * Yields the XMLTV document in chunks of at most ~64 KB. Channel icons are absolute when `baseUrl` is given
 * (no trailing slash), path-only otherwise.
 */
export function* xmltvChunks(catalog: Catalog, now: Date, baseUrl = ''): Generator<string> {
  let buffer = '';
  for (const piece of documentPieces(catalog, now, baseUrl)) {
    if (buffer.length + piece.length > CHUNK_LIMIT) {
      yield buffer;
      buffer = '';
    }
    buffer += piece;
  }
  if (buffer !== '') yield buffer;
}
