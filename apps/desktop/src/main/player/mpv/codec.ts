/** One mpv IPC command: the command name followed by its arguments. */
export type MpvCommand = readonly (
  | string
  | number
  | boolean
  | readonly string[]
  | Readonly<Record<string, string>>
)[];
/** The reply to a command carrying a `request_id`. */
export interface MpvReply {
  request_id: number;
  error: string;
  data?: unknown;
}
/** An asynchronous mpv event (no `request_id`). */
export type MpvEvent = { event: string } & Readonly<Record<string, unknown>>;

const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char sanitizer for mpv IPC JSON
const STRAY_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f]/g;

function sanitizeJsonLine(raw: string): string {
  return raw.replace(/\t/g, ' ').replace(STRAY_CONTROL_CHARS, '');
}

function parseObjectLine(raw: string): MpvReply | MpvEvent | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  try {
    const value: unknown = JSON.parse(sanitizeJsonLine(trimmed));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as MpvReply | MpvEvent;
    }
  } catch {
    // mpv only writes JSON objects on this channel; anything else is noise.
  }
  return undefined;
}

/** Encodes one command as a minified JSON line ending in a newline. */
export function encodeCommand(command: MpvCommand, requestId: number): string {
  return `${JSON.stringify({ command, request_id: requestId })}\n`;
}

/** Splits the byte stream from mpv into JSON messages; safe for multibyte characters split across chunks. */
export class LineDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private discarding = false;
  private readonly maxPendingBytes: number;

  constructor(maxPendingBytes = DEFAULT_MAX_PENDING_BYTES) {
    this.maxPendingBytes = maxPendingBytes;
  }

  /** Returns the complete messages in the chunk; blank, oversized and non-object lines are dropped. */
  push(chunk: Buffer): Array<MpvReply | MpvEvent> {
    let input = chunk;
    if (this.discarding) {
      const nl = input.indexOf(0x0a);
      if (nl === -1) return [];
      this.discarding = false;
      input = input.subarray(nl + 1);
    }

    const firstNl = input.indexOf(0x0a);
    if (firstNl === -1) {
      if (this.pending.length + input.length > this.maxPendingBytes) {
        this.pending = Buffer.alloc(0);
        this.discarding = true;
        return [];
      }
      this.pending =
        this.pending.length === 0 ? Buffer.from(input) : Buffer.concat([this.pending, input]);
      return [];
    }

    const out: Array<MpvReply | MpvEvent> = [];
    let buf: Buffer;
    let start = 0;
    if (this.pending.length + firstNl > this.maxPendingBytes) {
      this.pending = Buffer.alloc(0);
      buf = input;
      start = firstNl + 1;
    } else {
      buf = this.pending.length === 0 ? input : Buffer.concat([this.pending, input]);
    }

    for (let nl = buf.indexOf(0x0a, start); nl !== -1; nl = buf.indexOf(0x0a, start)) {
      if (nl - start <= this.maxPendingBytes) {
        const parsed = parseObjectLine(buf.subarray(start, nl).toString('utf8'));
        if (parsed !== undefined) out.push(parsed);
      }
      start = nl + 1;
    }

    const tail = buf.subarray(start);
    if (tail.length > this.maxPendingBytes) {
      this.pending = Buffer.alloc(0);
      this.discarding = true;
    } else {
      this.pending = Buffer.from(tail);
    }
    return out;
  }
}
