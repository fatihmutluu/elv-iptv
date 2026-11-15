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

/** Encodes one command as a minified JSON line ending in a newline. */
export function encodeCommand(command: MpvCommand, requestId: number): string {
  return `${JSON.stringify({ command, request_id: requestId })}\n`;
}

/** Splits the byte stream from mpv into JSON messages; safe for multibyte characters split across chunks. */
export class LineDecoder {
  private pending: Buffer = Buffer.alloc(0);

  /** Returns the complete messages in the chunk; blank and non-JSON lines are dropped. */
  push(chunk: Buffer): Array<MpvReply | MpvEvent> {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const out: Array<MpvReply | MpvEvent> = [];
    let start = 0;
    for (
      let nl = this.pending.indexOf(0x0a, start);
      nl !== -1;
      nl = this.pending.indexOf(0x0a, start)
    ) {
      const line = this.pending.subarray(start, nl).toString('utf8').trim();
      start = nl + 1;
      if (line === '') continue;
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value === 'object' && value !== null) out.push(value as MpvReply | MpvEvent);
      } catch {
        // mpv only writes JSON on this channel; anything else is noise.
      }
    }
    this.pending = Buffer.from(this.pending.subarray(start));
    return out;
  }
}
