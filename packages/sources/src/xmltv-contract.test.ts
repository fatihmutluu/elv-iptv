import { describe, expect, it } from 'vitest';
import { scanXmltv } from './xmltv';
import { collect, guide, whole } from './xmltv-test-helpers';

describe('scanXmltv batches count channels', () => {
  it('yields a batch whenever channels plus programmes reach batchSize', async () => {
    const channels = Array.from(
      { length: 3000 },
      (_, i) => `<channel id="c${i}"><display-name>C${i}</display-name></channel>`,
    ).join('');
    const out = await collect(whole(guide(channels)), { batchSize: 10 });
    expect(out.channels).toHaveLength(3000);
    expect(out.batches.length).toBeGreaterThan(1);
    expect(out.result).toEqual({ ok: true, value: undefined });
  });
});

describe('scanXmltv aborts', () => {
  it('returns network/aborted for an input that ends with an abort error', async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('<tv>');
      throw Object.assign(new Error('aborted'), { category: 'network', code: 'aborted' });
    }
    const gen = scanXmltv(chunks());
    const r = await gen.next();
    expect(r).toEqual({
      done: true,
      value: { ok: false, error: { category: 'network', code: 'aborted' } },
    });
  });
});
