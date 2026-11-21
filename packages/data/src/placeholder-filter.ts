import { foldText } from './fold';

/** Input inspected by {@link isPlaceholderLiveChannel}. */
export interface PlaceholderLiveChannelInput {
  readonly name: string;
  readonly streamId?: number | string | null;
}

const NEGATIVE_INT = /^-\d+$/;
const ZERO_ONLY = /^0+$/;

const PLACEHOLDER_PHRASES: ReadonlySet<string> = new Set([
  'no event streaming',
  'no event',
  'no live event',
  'no events',
  'event not started',
  'no stream available',
  'offline placeholder',
  'channel offline',
]);

const NO_EVENT_STREAMING_PREFIX = 'no event streaming ';

function isSentinelStreamId(streamId: number | string | null | undefined): boolean {
  if (streamId === undefined || streamId === null) return false;
  if (typeof streamId === 'number') return !Number.isFinite(streamId) || streamId <= 0;
  const trimmed = streamId.trim();
  return trimmed === '' || ZERO_ONLY.test(trimmed) || NEGATIVE_INT.test(trimmed);
}

/**
 * Returns `true` when a live channel entry is a provider offline/separator placeholder rather than a playable
 * channel (sentinel non-positive stream ID, divider-only non-alphanumeric name, or static offline event phrase).
 * Nameless playable streams (`""` / whitespace-only) with a valid or absent `streamId` are preserved, and
 * legitimate channel names like `"Event Cinema"` or `"Live Sports 1"` always pass.
 */
export function isPlaceholderLiveChannel(input: PlaceholderLiveChannelInput): boolean {
  if (isSentinelStreamId(input.streamId)) return true;
  const trimmed = input.name.trim();
  if (trimmed.length === 0) return false;
  const folded = foldText(trimmed);
  if (folded.length === 0) return true;
  return PLACEHOLDER_PHRASES.has(folded) || folded.startsWith(NO_EVENT_STREAMING_PREFIX);
}
