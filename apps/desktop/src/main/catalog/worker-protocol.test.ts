import { describe, expect, it } from 'vitest';
import { isMainToWorkerMessage, isWorkerToMainMessage } from './worker-protocol.ts';

describe('isMainToWorkerMessage', () => {
  it('accepts valid lifecycle, client port, and secret reply messages', () => {
    const valid: unknown[] = [
      { type: 'init', dbPath: '/tmp/catalog.db' },
      { type: 'client-port', clientId: 1 },
      { type: 'client-disconnect', clientId: 1 },
      { type: 'secret-reply', reqId: 7, ok: true, value: 'secret-payload' },
      { type: 'secret-reply', reqId: 8, ok: true, value: null },
      { type: 'secret-reply', reqId: 9, ok: false, message: 'unavailable' },
      { type: 'shutdown' },
    ];
    for (const msg of valid) {
      expect(isMainToWorkerMessage(msg)).toBe(true);
    }
  });

  it('rejects malformed main-to-worker payloads', () => {
    const invalid: unknown[] = [
      null,
      'shutdown',
      { type: 'init', dbPath: '' },
      { type: 'client-port', clientId: 0 },
      { type: 'client-disconnect', clientId: -3 },
      { type: 'secret-reply', reqId: 1, ok: true, value: 42 },
      { type: 'secret-reply', reqId: 1, ok: false, message: 42 },
      { type: 'secret-reply', reqId: 0, ok: true, value: null },
      { type: 'unknown' },
    ];
    for (const msg of invalid) {
      expect(isMainToWorkerMessage(msg)).toBe(false);
    }
  });
});

describe('isWorkerToMainMessage', () => {
  it('accepts ready, secret-request and shutdown-complete messages', () => {
    const valid: unknown[] = [
      { type: 'ready' },
      { type: 'secret-request', reqId: 1, op: 'get', key: 'source.src_1.xtream' },
      { type: 'secret-request', reqId: 2, op: 'delete', key: 'source.src_1.urlvars' },
      {
        type: 'secret-request',
        reqId: 3,
        op: 'set',
        key: 'source.src_1.playlist',
        value: 'http://x',
      },
      {
        type: 'secret-request',
        reqId: 4,
        op: 'set',
        key: 'source.src_1.urlvars',
        value: 'a'.repeat(131_072),
      },
      { type: 'shutdown-complete' },
    ];
    for (const msg of valid) {
      expect(isWorkerToMainMessage(msg)).toBe(true);
    }
  });

  it('rejects invalid keys, oversized secret values, or malformed worker-to-main payloads', () => {
    const invalid: unknown[] = [
      null,
      { type: 'secret-request', reqId: 0, op: 'get', key: 'source.src_1.xtream' },
      { type: 'secret-request', reqId: 1, op: 'get', key: 'bad/key' },
      { type: 'secret-request', reqId: 1, op: 'set', key: 'source.src_1.xtream' },
      {
        type: 'secret-request',
        reqId: 1,
        op: 'set',
        key: 'source.src_1.urlvars',
        value: 'a'.repeat(131_073),
      },
      { type: 'secret-request', reqId: 1, op: 'list', key: 'source.src_1.xtream' },
      { type: 'other' },
    ];
    for (const msg of invalid) {
      expect(isWorkerToMainMessage(msg)).toBe(false);
    }
  });
});
