import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyEnd, type MpvLogLine } from './errors.ts';

function fixture(
  name: string,
  dir = 'fixtures',
): { logs: MpvLogLine[]; reason: string; fileError?: string } {
  const lines = readFileSync(new URL(`./${dir}/${name}.jsonl`, import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, string>);
  const end = lines.find((l) => l['event'] === 'end-file');
  return {
    logs: lines
      .filter((l) => l['event'] === 'log-message')
      .map((l) => ({ prefix: l['prefix'] ?? '', level: l['level'] ?? '', text: l['text'] ?? '' })),
    reason: end?.['reason'] ?? 'error',
    ...(end?.['file_error'] ? { fileError: end['file_error'] } : {}),
  };
}
const err = (o: ReturnType<typeof classifyEnd>) => (o.kind === 'error' ? o.error : undefined);

describe.each([
  ['win32', 'fixtures'],
  ['darwin', 'fixtures/darwin'],
] as const)('classifyEnd from recorded %s fixtures', (_platform, dir) => {
  it.each([
    ['404', 'http-404', 404],
    ['403', 'http-403', 403],
    ['509', 'http-509', 509],
  ])('%s maps to %s', (name, code, httpStatus) => {
    const f = fixture(String(name), dir);
    const e = err(classifyEnd({ ...f, mediaKind: 'live' }));
    expect(e).toMatchObject({ code, httpStatus });
    expect(e?.detail).toContain(String(httpStatus));
  });
  it('notice maps to connection-limit', () => {
    expect(err(classifyEnd({ ...fixture('notice', dir), mediaKind: 'live' }))?.code).toBe(
      'connection-limit',
    );
  });
  it('refused maps to network', () => {
    expect(err(classifyEnd({ ...fixture('refused', dir), mediaKind: 'live' }))?.code).toBe(
      'network',
    );
  });
  it('drop5 on live is network with live-eof', () => {
    expect(err(classifyEnd({ ...fixture('drop5', dir), mediaKind: 'live' }))).toEqual({
      code: 'network',
      detail: 'live-eof',
    });
  });
});

describe('classifyEnd rules', () => {
  const line = (text: string): MpvLogLine => ({ prefix: 'ffmpeg', level: 'warn', text });
  const run = (logs: MpvLogLine[], fileError = 'loading failed') =>
    err(classifyEnd({ reason: 'error', fileError, logs, mediaKind: 'vod' }));

  it('eof on vod is ended', () => {
    expect(classifyEnd({ reason: 'eof', logs: [], mediaKind: 'vod' })).toEqual({ kind: 'ended' });
  });
  it.each(['stop', 'quit', 'redirect'])('%s is stopped', (reason) => {
    expect(classifyEnd({ reason, logs: [], mediaKind: 'live' })).toEqual({ kind: 'stopped' });
  });
  it('uses the last HTTP error line', () => {
    expect(run([line('HTTP error 404 Not Found'), line('HTTP error 401 Unauthorized')])?.code).toBe(
      'http-401',
    );
    expect(run([line('HTTP error 429 Too Many')])?.code).toBe('http-429');
  });
  it('other 4xx and 5xx are http-other with the status', () => {
    expect(run([line('HTTP error 503 Service Unavailable')])).toMatchObject({
      code: 'http-other',
      httpStatus: 503,
    });
    expect(run([line('HTTP error 418 Teapot')])).toMatchObject({
      code: 'http-other',
      httpStatus: 418,
    });
  });
  it('ignores an HTTP status outside 4xx and 5xx', () => {
    expect(run([line('HTTP error 302 Found')])?.code).toBe('unknown');
  });
  it('unrecognized file format without a text notice is unsupported-format', () => {
    expect(run([], 'unrecognized file format')?.code).toBe('unsupported-format');
  });
  it('reset and timeout are network', () => {
    expect(run([line('tcp: Connection reset by peer')])?.code).toBe('network');
    expect(run([line('Connection timed out')])?.code).toBe('network');
  });
  it('decoder failures map to decoder', () => {
    expect(run([line('no audio or video data played')])?.code).toBe('decoder');
    expect(run([line('Could not open codec h264.')])?.code).toBe('decoder');
  });
  it('anything else is unknown, carrying the file error', () => {
    expect(run([])).toEqual({ code: 'unknown', detail: 'loading failed' });
    expect(err(classifyEnd({ reason: 'error', logs: [], mediaKind: 'vod' }))?.detail).toBe(
      'unknown',
    );
  });
  it('detail never contains the password segment, queries or user-info', () => {
    const e = run([line('HTTP error 404 for http://u:p@h/live/demo/password/1.ts?token=abc')]);
    expect(e?.detail).not.toMatch(/password|token|u:p/);
    expect(e?.detail).toContain('/live/***/***/1.ts');
  });
  it('detail is at most 200 characters', () => {
    expect(run([line(`HTTP error 404 ${'x'.repeat(500)}`)])?.detail).toHaveLength(200);
  });
});
