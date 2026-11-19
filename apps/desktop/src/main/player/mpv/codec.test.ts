import { describe, expect, it } from 'vitest';
import { encodeCommand, LineDecoder } from './codec.ts';

describe('encodeCommand', () => {
  it('encodes loadfile with index -1 and an options map', () => {
    const line = encodeCommand(
      ['loadfile', 'http://x/a.ts', 'replace', -1, { 'user-agent': 'U' }],
      1,
    );
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      command: ['loadfile', 'http://x/a.ts', 'replace', -1, { 'user-agent': 'U' }],
      request_id: 1,
    });
    expect(line.trim()).not.toContain(' ');
  });
});

describe('LineDecoder', () => {
  it('decodes a reply split across chunks', () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from('{"request_id":1,"err'))).toEqual([]);
    expect(d.push(Buffer.from('or":"success"}\n{"event":"idle"}\n'))).toEqual([
      { request_id: 1, error: 'success' },
      { event: 'idle' },
    ]);
  });

  it('decodes a multibyte character split across chunks', () => {
    const bytes = Buffer.from('{"event":"x","t":"Türkçe €"}\n');
    const cut = bytes.indexOf(0xe2) + 1;
    const d = new LineDecoder();
    expect(d.push(bytes.subarray(0, cut))).toEqual([]);
    expect(d.push(bytes.subarray(cut))).toEqual([{ event: 'x', t: 'Türkçe €' }]);
  });

  it('ignores blank lines, CRLF, JSON arrays and lines that are not JSON', () => {
    const d = new LineDecoder();
    expect(
      d.push(Buffer.from('\n\r\nnot json\n[1,2,3]\n"str"\n42\nnull\n{"event":"a"}\r\n')),
    ).toEqual([{ event: 'a' }]);
  });

  it('sanitizes stray ASCII control characters (0x00-0x1F) inside JSON lines before parsing', () => {
    const d = new LineDecoder();
    const raw = Buffer.from('{"event":"log-message","text":"bad\u0000char\u001b[31m\twarn"}\n');
    expect(d.push(raw)).toEqual([{ event: 'log-message', text: 'badchar[31m warn' }]);
  });

  it('caps pending buffer to prevent OOM and recovers after the oversized line ends', () => {
    const d = new LineDecoder(64);
    expect(d.push(Buffer.from('{"event":"oversized","pad":"' + 'x'.repeat(100)))).toEqual([]);
    expect(d.push(Buffer.from('y'.repeat(100)))).toEqual([]);
    expect(d.push(Buffer.from('"}\n{"event":"recovered"}\n'))).toEqual([{ event: 'recovered' }]);
  });

  it('drops an oversized line whose newline arrives in the second chunk within a multi-line push', () => {
    const d = new LineDecoder(64);
    expect(d.push(Buffer.from('{"event":"oversized","pad":"' + 'x'.repeat(30)))).toEqual([]);
    expect(d.push(Buffer.from('y'.repeat(40) + '"}\n{"event":"ok"}\n'))).toEqual([{ event: 'ok' }]);
  });
});
