import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMpvClient, MpvWedgedError } from './client.ts';
import type { MpvEvent } from './codec.ts';

/** A fake pipe: `written` collects what the client sends, `feed` plays mpv's side. */
function fakePipe() {
  const written: string[] = [];
  const incoming = new PassThrough();
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      written.push(chunk.toString('utf8'));
      cb();
    },
  });
  incoming.on('data', (d: Buffer) => stream.push(d));
  return {
    stream,
    written,
    feed: (s: string) => incoming.write(s),
    lastRequest: () =>
      JSON.parse(written[written.length - 1] ?? '{}') as { command: unknown[]; request_id: number },
  };
}
const tick = () => new Promise<void>((r) => setImmediate(r));

afterEach(() => vi.useRealTimers());

describe('createMpvClient', () => {
  it('request ids start at 1 and increase', async () => {
    const p = fakePipe();
    const c = createMpvClient(p.stream, { replyTimeoutMs: 3000 });
    const a = c.command(['get_property', 'pause']);
    const b = c.command(['get_property', 'speed']);
    expect(p.written.map((w) => (JSON.parse(w) as { request_id: number }).request_id)).toEqual([
      1, 2,
    ]);
    p.feed(
      '{"request_id":2,"error":"success","data":1}\n{"request_id":1,"error":"success","data":false}\n',
    );
    expect(await a).toMatchObject({ request_id: 1, data: false });
    expect(await b).toMatchObject({ request_id: 2, data: 1 });
  });

  it('routes property-change by observe id and keeps replies out of events', async () => {
    const p = fakePipe();
    const c = createMpvClient(p.stream, { replyTimeoutMs: 3000 });
    const events: MpvEvent[] = [];
    c.onEvent((e) => events.push(e));
    const id = c.observe('pause');
    const sent = p.lastRequest();
    expect(sent.command).toEqual(['observe_property', id, 'pause']);
    p.feed(`{"request_id":${sent.request_id},"error":"success"}\n`);
    p.feed(`{"event":"property-change","id":${id},"name":"pause","data":true}\n`);
    await tick();
    expect(events).toEqual([{ event: 'property-change', id, name: 'pause', data: true }]);
    expect(c.observe('speed')).toBe(id + 1);
  });

  it('stops delivering events after the unsubscribe function runs', async () => {
    const p = fakePipe();
    const c = createMpvClient(p.stream, { replyTimeoutMs: 3000 });
    const seen: string[] = [];
    const off = c.onEvent((e) => seen.push(e.event));
    p.feed('{"event":"a"}\n');
    await tick();
    off();
    p.feed('{"event":"b"}\n');
    await tick();
    expect(seen).toEqual(['a']);
  });

  it('rejects a pending command with MpvWedgedError after 3000 ms', async () => {
    vi.useFakeTimers();
    const p = fakePipe();
    const c = createMpvClient(p.stream, { replyTimeoutMs: 3000 });
    const pending = c.command(['get_property', 'pause']);
    const assertion = expect(pending).rejects.toBeInstanceOf(MpvWedgedError);
    await vi.advanceTimersByTimeAsync(2999);
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
  });

  it('does not time out a command that was answered', async () => {
    vi.useFakeTimers();
    const p = fakePipe();
    const c = createMpvClient(p.stream, { replyTimeoutMs: 3000 });
    const pending = c.command(['get_property', 'pause']);
    p.feed('{"request_id":1,"error":"success"}\n');
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ error: 'success' });
    await vi.advanceTimersByTimeAsync(5000);
  });

  it('rejects pending commands and notifies onClose when the stream closes', async () => {
    const p = fakePipe();
    const c = createMpvClient(p.stream, { replyTimeoutMs: 3000 });
    const closed = vi.fn();
    c.onClose(closed);
    const pending = c.command(['get_property', 'pause']);
    const assertion = expect(pending).rejects.toThrow(/closed/);
    p.stream.push(null);
    p.stream.emit('close');
    await assertion;
    expect(closed).toHaveBeenCalledTimes(1);
    await expect(c.command(['quit'])).rejects.toThrow(/closed/);
  });

  it('close destroys the stream', () => {
    const p = fakePipe();
    const c = createMpvClient(p.stream, { replyTimeoutMs: 3000 });
    c.close();
    expect(p.stream.destroyed).toBe(true);
  });
});

describe('listener isolation', () => {
  it('keeps delivering to later listeners when one throws', async () => {
    const p = fakePipe();
    const c = createMpvClient(p.stream, { replyTimeoutMs: 3000 });
    const seen: string[] = [];
    c.onEvent(() => {
      throw new Error('boom');
    });
    c.onEvent((e) => seen.push(e.event));
    p.feed('{"event":"a"}\n{"event":"b"}\n');
    await tick();
    expect(seen).toEqual(['a', 'b']);
  });
});
