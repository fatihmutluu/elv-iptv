import { describe, expect, it } from 'vitest';
import { scanXmltv } from './xmltv';
import { guide, whole } from './xmltv-test-helpers';

describe('scanXmltv batches count channels', () => {
  it('yields a batch whenever channels plus programmes reach batchSize', async () => {
    const channels = Array.from(
      { length: 3000 },
      (_, i) => `<channel id="c${i}"><display-name>C${i}</display-name></channel>`,
    ).join('');
    const sizes: number[] = [];
    for await (const batch of scanXmltv(whole(guide(channels)), { batchSize: 10 })) {
      sizes.push(batch.channels.length + batch.programmes.length);
    }
    expect(Math.max(...sizes)).toBe(10);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(3000);
    expect(sizes.filter((n) => n === 10)).toHaveLength(300);
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
