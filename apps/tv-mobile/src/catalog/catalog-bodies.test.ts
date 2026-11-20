import { DEVICE_MAX_BODY_BYTES } from '@elv/data';
import { describe, expect, it } from 'vitest';
import { addAccount, createTestHttp, env, must, useSim } from './catalog-test-env';

const sim = useSim();

async function account(
  name: 'demo' | 'large',
  getHttp: ReturnType<typeof createTestHttp> = createTestHttp(),
) {
  const e = await env({ http: getHttp });
  return { service: e.service, id: await addAccount(e, sim.url(), name, name) };
}
const recording = (urls: string[]): ReturnType<typeof createTestHttp> => {
  const client = createTestHttp();
  return {
    get: (url, options) => {
      urls.push(url);
      return client.get(url, options);
    },
  };
};
const perCategory = (urls: string[]) =>
  urls.some((u) => u.includes('get_live_streams&category_id='));

describe('bounded Xtream bodies', () => {
  it('defaults to a 4 MiB body cap and falls back to per-category loading when exceeded', async () => {
    expect(DEVICE_MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
    const urls: string[] = [];
    const { service, id } = await account('demo', recording(urls));
    const summary = must(await service.importSource(id, { maxBodyBytes: 4096 }));
    expect(perCategory(urls)).toBe(true);
    expect(summary.counts.live).toBeGreaterThan(0);
  });

  it('lets the import options raise the limit, which loads the lists whole', async () => {
    const urls: string[] = [];
    const { service, id } = await account('demo', recording(urls));
    must(await service.importSource(id, { maxBodyBytes: 1024 * 1024 }));
    expect(perCategory(urls)).toBe(false);
  });

  it('retries each category over the cap once without it', async () => {
    const urls: string[] = [];
    const { service, id } = await account('demo', recording(urls));
    const whole = await account('demo');
    const reference = must(
      await whole.service.importSource(whole.id, { maxBodyBytes: 1024 * 1024 }),
    );
    const capped = must(await service.importSource(id, { maxBodyBytes: 512 }));
    expect(capped.counts).toEqual(reference.counts);
    expect(urls.filter((u) => u.endsWith('get_live_streams&category_id=1'))).toHaveLength(2);
  });

  it('imports the same rows whole and per category', async () => {
    const a = await account('demo');
    const b = await account('demo');
    const whole = must(await a.service.importSource(a.id, { maxBodyBytes: 1024 * 1024 }));
    const bounded = must(await b.service.importSource(b.id, { maxBodyBytes: 4096 }));
    expect(bounded.counts.live).toBe(whole.counts.live);
    expect(bounded.counts.movies).toBe(whole.counts.movies);
    expect(bounded.counts.series).toBe(whole.counts.series);
  });

  it.skipIf(process.env.ELV_BENCH !== '1')(
    'limits response bodies to 4 MiB by default on the 95,500-row large profile',
    { timeout: 60_000 },
    async () => {
      expect(DEVICE_MAX_BODY_BYTES).toBe(4 * 1024 * 1024);
      const urls: string[] = [];
      const { service, id } = await account('large', recording(urls));
      const summary = must(await service.importSource(id));
      expect(perCategory(urls)).toBe(true);
      expect(summary.counts.live).toBeGreaterThan(0);
    },
  );
});
