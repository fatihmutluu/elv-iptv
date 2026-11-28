import { describe, expect, it, vi } from 'vitest';
import { createHostConnectivityGuard, type HostGuardTicket } from './host-connectivity-guard';
import { createFetchHttpClient } from './http';

function netErr(code: string, message = code): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(message), { code }),
  });
}

function headers(h: Record<string, string>) {
  return {
    forEach: (cb: (v: string, k: string) => void) => {
      for (const [k, v] of Object.entries(h)) cb(v, k);
    },
  };
}

describe('HostConnectivityGuard (NET-4)', () => {
  it('opens circuit for 30s after 2 non-sibling pre-connect failures within 120s and isolates origins by scheme and port', () => {
    let now = 1_000;
    const guard = createHostConnectivityGuard({ now: () => now });

    const a1 = guard.acquire('https://dead.example/api');
    expect(a1.allowed).toBe(true);
    if (a1.allowed) guard.reportFailure(a1.ticket, netErr('ECONNREFUSED'));

    // Still closed after 1 failure
    now += 1_000;
    const a2 = guard.acquire('https://dead.example/epg');
    expect(a2.allowed).toBe(true);
    if (a2.allowed) guard.reportFailure(a2.ticket, netErr('ENOTFOUND'));

    // Now open for 30s
    const blocked = guard.acquire('https://dead.example/list.m3u');
    expect(blocked).toEqual({
      allowed: false,
      origin: 'https://dead.example',
      retryAfterMs: 30_000,
    });

    // HTTP on same host and different port on same host remain unaffected
    expect(guard.acquire('http://dead.example/api').allowed).toBe(true);
    expect(guard.acquire('https://dead.example:8443/api').allowed).toBe(true);

    // Trailing dot normalizes to same origin
    expect(guard.acquire('https://dead.example./api').allowed).toBe(false);
  });

  it('does not double-count concurrent sibling failures admitted before the first failure', () => {
    let now = 10_000;
    const guard = createHostConnectivityGuard({ now: () => now });

    const s1 = guard.acquire('https://burst.example/1');
    const s2 = guard.acquire('https://burst.example/2');
    const s3 = guard.acquire('https://burst.example/3');
    expect(s1.allowed && s2.allowed && s3.allowed).toBe(true);

    if (s1.allowed) guard.reportFailure(s1.ticket, netErr('ECONNREFUSED'));
    if (s2.allowed) guard.reportFailure(s2.ticket, netErr('ECONNREFUSED'));
    if (s3.allowed) guard.reportFailure(s3.ticket, netErr('ECONNREFUSED'));

    // Only 1 failure epoch counted; circuit must still admit a subsequent attempt
    now += 500;
    const next = guard.acquire('https://burst.example/4');
    expect(next.allowed).toBe(true);

    // Second sequential failure opens the circuit
    if (next.allowed) guard.reportFailure(next.ticket, netErr('EHOSTUNREACH'));
    expect(guard.acquire('https://burst.example/5').allowed).toBe(false);
  });

  it('allows exactly 1 half-open probe after cooldown and closes on success or re-opens on failure', () => {
    let now = 5_000;
    const guard = createHostConnectivityGuard({ now: () => now });

    for (let i = 0; i < 2; i++) {
      const a = guard.acquire('https://flaky.example/a');
      if (a.allowed) guard.reportFailure(a.ticket, netErr('ETIMEDOUT'));
    }
    expect(guard.acquire('https://flaky.example/a').allowed).toBe(false);

    // Advance past 30s cooldown
    now += 30_000;
    const probe = guard.acquire('https://flaky.example/probe');
    expect(probe.allowed).toBe(true);
    if (probe.allowed) expect(probe.ticket?.isHalfOpenProbe).toBe(true);

    // Concurrent second request while probe is in flight is fast-failed
    expect(guard.acquire('https://flaky.example/concurrent').allowed).toBe(false);

    // Probe fails -> circuit immediately re-opens for another 30s
    if (probe.allowed) guard.reportFailure(probe.ticket, netErr('ENETUNREACH'));
    const blockedAgain = guard.acquire('https://flaky.example/after-fail');
    expect(blockedAgain).toEqual({
      allowed: false,
      origin: 'https://flaky.example',
      retryAfterMs: 30_000,
    });

    // Advance past second cooldown; probe succeeds -> circuit closes
    now += 30_000;
    const probe2 = guard.acquire('https://flaky.example/probe2');
    expect(probe2.allowed).toBe(true);
    if (probe2.allowed) guard.reportSuccess(probe2.ticket);

    expect(guard.acquire('https://flaky.example/normal1').allowed).toBe(true);
    expect(guard.acquire('https://flaky.example/normal2').allowed).toBe(true);
  });

  it('does not wedge half-open state when a probe is released/aborted without failure', () => {
    let now = 1_000;
    const guard = createHostConnectivityGuard({ now: () => now });
    for (let i = 0; i < 2; i++) {
      const a = guard.acquire('https://abort.example/a');
      if (a.allowed) guard.reportFailure(a.ticket, netErr('EAI_AGAIN'));
    }
    now += 30_000;
    const probe = guard.acquire('https://abort.example/p1');
    expect(probe.allowed).toBe(true);
    if (probe.allowed) guard.release(probe.ticket);

    // Next attempt is immediately admitted as a probe instead of wedged
    const probe2 = guard.acquire('https://abort.example/p2');
    expect(probe2.allowed).toBe(true);
    if (probe2.allowed) expect(probe2.ticket?.isHalfOpenProbe).toBe(true);
  });

  it('never counts ECONNRESET, caller aborts, post-connect failures, redirect-hop failures, or expired window failures', () => {
    let now = 1_000;
    const guard = createHostConnectivityGuard({ now: () => now });

    // ECONNRESET never counts
    for (let i = 0; i < 4; i++) {
      const a = guard.acquire('https://reset.example/a');
      if (a.allowed) guard.reportFailure(a.ticket, netErr('ECONNRESET'));
    }
    expect(guard.acquire('https://reset.example/a').allowed).toBe(true);

    // AbortError never counts
    for (let i = 0; i < 4; i++) {
      const a = guard.acquire('https://abort-err.example/a');
      if (a.allowed) {
        guard.reportFailure(a.ticket, Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }
    }
    expect(guard.acquire('https://abort-err.example/a').allowed).toBe(true);

    // Post-connect (TCP connected) timeout never trips breaker
    for (let i = 0; i < 4; i++) {
      const a = guard.acquire('https://slow.example/a');
      if (a.allowed) {
        guard.reportConnected(a.ticket);
        guard.reportFailure(a.ticket, new Error('timeout'), { timedOut: true });
      }
    }
    expect(guard.acquire('https://slow.example/a').allowed).toBe(true);

    // reportOriginConnected prevents slow timeout from tripping breaker
    for (let i = 0; i < 4; i++) {
      const a = guard.acquire('https://slow-node.example/a');
      if (a.allowed) {
        guard.reportOriginConnected('https://slow-node.example/a');
        guard.reportFailure(a.ticket, new Error('timeout'), { timedOut: true });
      }
    }
    expect(guard.acquire('https://slow-node.example/a').allowed).toBe(true);

    // failedAfterRedirect never trips origin breaker
    for (let i = 0; i < 4; i++) {
      const a = guard.acquire('https://redir.example/a');
      if (a.allowed) {
        guard.reportFailure(a.ticket, netErr('ECONNREFUSED'), { failedAfterRedirect: true });
      }
    }
    expect(guard.acquire('https://redir.example/a').allowed).toBe(true);

    // Failure outside 120s window expires
    const w1 = guard.acquire('https://window.example/a');
    if (w1.allowed) guard.reportFailure(w1.ticket, netErr('ECONNREFUSED'));
    now += 120_001;
    const w2 = guard.acquire('https://window.example/a');
    if (w2.allowed) guard.reportFailure(w2.ticket, netErr('ECONNREFUSED'));
    expect(guard.acquire('https://window.example/a').allowed).toBe(true);
  });

  it('recognizes AggregateError connectivity failures (Node Happy Eyeballs) and supports resetOrigin / resetAll', () => {
    const now = 1_000;
    const guard = createHostConnectivityGuard({ now: () => now });

    const agg = new AggregateError(
      [
        Object.assign(new Error('connect ECONNREFUSED ::1'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1'), { code: 'ECONNREFUSED' }),
      ],
      'connect failed',
    );
    const a1 = guard.acquire('https://agg.example/1');
    if (a1.allowed) guard.reportFailure(a1.ticket, agg);
    const a2 = guard.acquire('https://agg.example/2');
    if (a2.allowed) guard.reportFailure(a2.ticket, { cause: agg });
    expect(guard.acquire('https://agg.example/3').allowed).toBe(false);

    // resetOrigin clears only that origin; stale in-flight tickets from before reset cannot re-poison
    const stale = guard.acquire('https://other.example/1');
    guard.resetOrigin('https://agg.example/any-path');
    expect(guard.acquire('https://agg.example/3').allowed).toBe(true);
    guard.resetAll();
    if (stale.allowed) guard.reportFailure(stale.ticket, netErr('ECONNREFUSED'));
    const nextOther = guard.acquire('https://other.example/2');
    if (nextOther.allowed) guard.reportFailure(nextOther.ticket, netErr('ECONNREFUSED'));
    // Only 1 failure counted after resetAll (stale was ignored)
    expect(guard.acquire('https://other.example/3').allowed).toBe(true);
  });

  it('wires into createFetchHttpClient, ignores 4xx/5xx & redirect failures, and honors skipGuard', async () => {
    const now = 10_000;
    const guard = createHostConnectivityGuard({ now: () => now });
    let mode: 'refused' | 'http500' | 'redirect-fail' | 'ok' = 'refused';
    const fetchImpl = vi.fn(async (url: string) => {
      if (mode === 'refused') throw netErr('ECONNREFUSED');
      if (mode === 'http500') return { status: 500, headers: headers({}), body: null };
      if (mode === 'redirect-fail') {
        if (url.startsWith('https://origin.example')) {
          return {
            status: 302,
            headers: headers({ Location: 'https://cdn-down.example/video' }),
            body: null,
          };
        }
        throw netErr('ECONNREFUSED');
      }
      return { status: 200, headers: headers({}), body: null };
    });

    const client = createFetchHttpClient(fetchImpl, { connectivityGuard: guard });

    // Two sequential ECONNREFUSED failures trip the breaker
    expect((await client.get('https://down.example/a')).ok).toBe(false);
    expect((await client.get('https://down.example/b')).ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Third request fast-fails without hitting fetchImpl
    const fastFail = await client.get('https://down.example/c');
    expect(fastFail).toEqual({
      ok: false,
      error: { category: 'network', code: 'host-unreachable' },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // skipGuard: true bypasses open circuit for explicit discovery/retry probes
    mode = 'ok';
    const bypassed = await client.get('https://down.example/probe', { skipGuard: true });
    expect(bypassed.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // HTTP 500 responses never trip breaker
    mode = 'http500';
    for (let i = 0; i < 3; i++) {
      expect((await client.get('https://err500.example/a')).ok).toBe(false);
    }
    expect(guard.acquire('https://err500.example/a').allowed).toBe(true);

    // Redirect-hop downstream failure never trips initial origin's breaker
    mode = 'redirect-fail';
    for (let i = 0; i < 3; i++) {
      expect((await client.get('https://origin.example/start')).ok).toBe(false);
    }
    expect(guard.acquire('https://origin.example/start').allowed).toBe(true);

    // Pre-connect timeout counts toward opening the circuit while caller abort does not
    const hangingFetch = vi.fn((_url: string, init: { signal?: AbortSignal }) => {
      return new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const timeoutGuard = createHostConnectivityGuard({ now: () => now });
    const timeoutClient = createFetchHttpClient(hangingFetch, {
      timeoutMs: 10,
      connectivityGuard: timeoutGuard,
    });
    const abortedCtl = new AbortController();
    const abortedPromise = timeoutClient.get('https://hang.example/0', {
      signal: abortedCtl.signal,
    });
    abortedCtl.abort();
    expect(await abortedPromise).toEqual({
      ok: false,
      error: { category: 'network', code: 'aborted' },
    });
    expect(await timeoutClient.get('https://hang.example/1')).toEqual({
      ok: false,
      error: { category: 'network', code: 'timeout' },
    });
    expect(await timeoutClient.get('https://hang.example/2')).toEqual({
      ok: false,
      error: { category: 'network', code: 'timeout' },
    });
    expect(await timeoutClient.get('https://hang.example/3')).toEqual({
      ok: false,
      error: { category: 'network', code: 'host-unreachable' },
    });
    expect(hangingFetch).toHaveBeenCalledTimes(3);
  });

  it('ignores late reportConnected() on an already-settled ticket and supports trustTimeoutAsPreConnect: false (M6)', async () => {
    const now = 1_000;
    const guard = createHostConnectivityGuard({ now: () => now });

    // Ticket 1 settles via release (e.g. caller abort), then two later failures open the circuit
    const settledAborted = guard.acquire('https://late.example/1');
    expect(settledAborted.allowed).toBe(true);
    if (settledAborted.allowed) guard.release(settledAborted.ticket);

    let lastFailedTicket: HostGuardTicket | undefined;
    for (let i = 0; i < 2; i++) {
      const a = guard.acquire('https://late.example/fail');
      if (a.allowed) {
        guard.reportFailure(a.ticket, netErr('ECONNREFUSED'));
        lastFailedTicket = a.ticket;
      }
    }
    expect(guard.acquire('https://late.example/check').allowed).toBe(false);

    // Late reportConnected on settled (released or failed) tickets MUST NOT close the newly-opened circuit
    if (settledAborted.allowed) guard.reportConnected(settledAborted.ticket);
    guard.reportConnected(lastFailedTicket);
    expect(guard.acquire('https://late.example/check2').allowed).toBe(false);

    // trustTimeoutAsPreConnect: false ignores generic timeoutMs aborts while counting explicit connect codes
    const noTrustGuard = createHostConnectivityGuard({ now: () => now });
    let failConnect = false;
    const client = createFetchHttpClient(
      (_url, init) => {
        if (failConnect) return Promise.reject(netErr('UND_ERR_CONNECT_TIMEOUT'));
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
      {
        timeoutMs: 10,
        connectivityGuard: noTrustGuard,
        trustTimeoutAsPreConnect: false,
      },
    );
    expect(await client.get('https://slow-undici.example/1')).toEqual({
      ok: false,
      error: { category: 'network', code: 'timeout' },
    });
    expect(await client.get('https://slow-undici.example/2')).toEqual({
      ok: false,
      error: { category: 'network', code: 'timeout' },
    });
    expect(noTrustGuard.acquire('https://slow-undici.example/3').allowed).toBe(true);

    failConnect = true;
    expect((await client.get('https://dead-undici.example/1')).ok).toBe(false);
    expect((await client.get('https://dead-undici.example/2')).ok).toBe(false);
    expect(await client.get('https://dead-undici.example/3')).toEqual({
      ok: false,
      error: { category: 'network', code: 'host-unreachable' },
    });
  });
});
