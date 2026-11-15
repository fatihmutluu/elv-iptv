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

  it('ignores blank lines, CRLF and lines that are not JSON', () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from('\n\r\nnot json\n{"event":"a"}\r\n'))).toEqual([{ event: 'a' }]);
  });
});
