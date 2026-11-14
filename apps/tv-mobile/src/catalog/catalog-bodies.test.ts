import { describe, expect, it } from 'vitest';
import { DEVICE_MAX_BODY_BYTES } from './catalog';
import { addAccount, env, http, must, useSim } from './catalog-test-env';

const sim = useSim();

async function large(getHttp: typeof http) {
  const e = await env({ http: getHttp });
  return { service: e.service, id: await addAccount(e, sim.url(), 'large', 'Large') };
}
const recording = (urls: string[]): typeof http => ({
  get: (url, options) => {
    urls.push(url);
    return http.get(url, options);
  },
});
const perCategory = (urls: string[]) =>
  urls.some((u) => u.includes('get_live_streams&category_id='));

describe('bounded Xtream bodies', () => {
  it('limits response bodies to 4 MiB by default, so the large lists load per category', {
    timeout: 30_000,
  }, async () => {
    expect(DEVICE_MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
    const urls: string[] = [];
    const { service, id } = await large(recording(urls));
    const summary = must(await service.importSource(id));
    expect(perCategory(urls)).toBe(true);
    expect(summary.counts.live).toBeGreaterThan(0);
  });

  it('lets the import options raise the limit, which loads the lists whole', {
    timeout: 30_000,
  }, async () => {
    const urls: string[] = [];
    const { service, id } = await large(recording(urls));
    must(await service.importSource(id, { maxBodyBytes: 128 * 1024 * 1024 }));
    expect(perCategory(urls)).toBe(false);
  });

  it('retries each category over a 64 KiB cap once without it', { timeout: 60_000 }, async () => {
    const urls: string[] = [];
    const { service, id } = await large(recording(urls));
    const whole = await large(http);
    const reference = must(
      await whole.service.importSource(whole.id, { maxBodyBytes: 128 * 1024 * 1024 }),
    );
    const capped = must(await service.importSource(id, { maxBodyBytes: 64 * 1024 }));
    expect(capped.counts).toEqual(reference.counts);
    expect(urls.filter((u) => u.endsWith('get_live_streams&category_id=1'))).toHaveLength(2);
  });

  it('imports the same rows whole and per category', { timeout: 30_000 }, async () => {
    const a = await large(http);
    const b = await large(http);
    const whole = must(await a.service.importSource(a.id, { maxBodyBytes: 128 * 1024 * 1024 }));
    const bounded = must(await b.service.importSource(b.id, { maxBodyBytes: 1024 * 1024 }));
    expect(bounded.counts.live).toBe(whole.counts.live);
    expect(bounded.counts.movies).toBe(whole.counts.movies);
    expect(bounded.counts.series).toBe(whole.counts.series);
  });
});
