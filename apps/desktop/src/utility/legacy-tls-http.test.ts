import type { FetchLike } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  createDesktopHttpClient,
  createLegacyTlsAgent,
  LEGACY_TLS_CIPHERS,
  LEGACY_TLS_MIN_VERSION,
} from './legacy-tls-http.ts';

function okFetch(bodyText: string): FetchLike {
  return vi.fn(async (url) => ({
    status: 200,
    url,
    headers: {
      forEach: () => {},
      get: () => null,
      getSetCookie: () => [],
    },
    body: (async function* () {
      yield new TextEncoder().encode(bodyText);
    })(),
  }));
}

async function drainText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

describe('createDesktopHttpClient & legacy TLS (#182)', () => {
  it('routes default requests strictly to the modern fetch client and legacy requests strictly to the isolated legacy client', async () => {
    const modernFetch = okFetch('modern-response');
    const legacyFetch = okFetch('legacy-response');
    const client = createDesktopHttpClient(modernFetch, { legacyFetchImpl: legacyFetch });

    const r1 = await client.get('https://modern.example/list.m3u');
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(await drainText(r1.value.body)).toBe('modern-response');
    expect(modernFetch).toHaveBeenCalledTimes(1);
    expect(legacyFetch).not.toHaveBeenCalled();

    const r2 = await client.get('https://legacy.example/list.m3u', { allowLegacyTls: true });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(await drainText(r2.value.body)).toBe('legacy-response');
    expect(modernFetch).toHaveBeenCalledTimes(1);
    expect(legacyFetch).toHaveBeenCalledTimes(1);

    const r3 = await client.get('https://modern2.example/list.m3u', { allowLegacyTls: false });
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(await drainText(r3.value.body)).toBe('modern-response');
    expect(modernFetch).toHaveBeenCalledTimes(2);
    expect(legacyFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects non-http(s) protocols on both modern and legacy clients', async () => {
    const modernFetch = okFetch('no');
    const legacyFetch = okFetch('no');
    const client = createDesktopHttpClient(modernFetch, { legacyFetchImpl: legacyFetch });

    const r1 = await client.get('file:///etc/passwd');
    const r2 = await client.get('file:///etc/passwd', { allowLegacyTls: true });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(modernFetch).not.toHaveBeenCalled();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('configures the isolated legacy HTTPS agent with TLSv1, SECLEVEL=0 ciphers, and certificate verification intact', () => {
    const agent = createLegacyTlsAgent();
    try {
      expect(agent.options.minVersion).toBe(LEGACY_TLS_MIN_VERSION);
      expect(agent.options.ciphers).toBe(LEGACY_TLS_CIPHERS);
      expect(agent.options.rejectUnauthorized).toBe(true);
    } finally {
      agent.destroy();
    }
  });
});
