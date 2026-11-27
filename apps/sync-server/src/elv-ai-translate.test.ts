import { describe, expect, it, vi } from 'vitest';
import {
  isEnglishLang,
  translateSynopsisWithWorkersAi,
  WORKERS_AI_TRANSLATION_MODEL,
} from './elv-ai-translate.ts';
import type { WorkersAiBinding } from './elv-types.ts';

describe('translateSynopsisWithWorkersAi', () => {
  it('skips AI completely for English locales (0 calls)', async () => {
    const run = vi.fn<WorkersAiBinding['run']>();
    const ai: WorkersAiBinding = { run };

    expect(isEnglishLang('en')).toBe(true);
    expect(isEnglishLang('en-US')).toBe(true);
    expect(isEnglishLang('tr')).toBe(false);

    const res = await translateSynopsisWithWorkersAi({
      ai,
      title: 'Inception',
      originalSynopsis: 'A skilled thief enters dreams to steal corporate secrets.',
      targetLang: 'en',
    });

    expect(run).not.toHaveBeenCalled();
    expect(res).toEqual({
      synopsis: 'A skilled thief enters dreams to steal corporate secrets.',
      source: 'original',
      translated: false,
    });
  });

  it('calls Llama 3.1 8B Instruct Fast with tight parameters and sanitizes prefaces/quotes', async () => {
    const run = vi.fn<WorkersAiBinding['run']>(async (model, inputs) => {
      expect(model).toBe(WORKERS_AI_TRANSLATION_MODEL);
      expect(inputs.max_tokens).toBe(280);
      expect(inputs.temperature).toBe(0.2);
      expect(Array.isArray(inputs.messages)).toBe(true);
      return {
        response:
          'Türkçe çeviri: "Rüyalara sızarak kurumsal sırları çalan yetenekli bir hırsız, son bir görevle karşı karşıya kalır."',
      };
    });
    const ai: WorkersAiBinding = { run };

    const res = await translateSynopsisWithWorkersAi({
      ai,
      title: 'Inception',
      originalSynopsis: 'A skilled thief enters dreams to steal corporate secrets.',
      targetLang: 'tr',
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      synopsis:
        'Rüyalara sızarak kurumsal sırları çalan yetenekli bir hırsız, son bir görevle karşı karşıya kalır.',
      source: 'workers_ai',
      translated: true,
    });
  });

  it('also parses OpenAI-compatible choices[0].message.content responses', async () => {
    const ai: WorkersAiBinding = {
      run: async () => ({
        choices: [
          {
            message: {
              content: '  Ein geschickter Dieb dringt in Träume ein, um Geheimnisse zu stehlen.  ',
            },
          },
        ],
      }),
    };

    const res = await translateSynopsisWithWorkersAi({
      ai,
      title: 'Inception',
      originalSynopsis: 'A skilled thief enters dreams to steal secrets.',
      targetLang: 'de',
    });

    expect(res.translated).toBe(true);
    expect(res.source).toBe('workers_ai');
    expect(res.synopsis).toBe(
      'Ein geschickter Dieb dringt in Träume ein, um Geheimnisse zu stehlen.',
    );
  });

  it('falls back cleanly to original English synopsis on AI error, timeout, or missing binding without throwing', async () => {
    const failingAi: WorkersAiBinding = {
      run: async () => {
        throw new Error('Workers AI quota temporarily exhausted');
      },
    };
    const original = 'A family saga with a supernatural twist set in a German town.';

    const errRes = await translateSynopsisWithWorkersAi({
      ai: failingAi,
      title: 'Dark',
      originalSynopsis: original,
      targetLang: 'tr',
    });
    expect(errRes).toEqual({
      synopsis: original,
      source: 'fallback_en',
      translated: false,
    });

    const slowAi: WorkersAiBinding = {
      run: () => new Promise(() => {}),
    };
    const timeoutRes = await translateSynopsisWithWorkersAi({
      ai: slowAi,
      title: 'Dark',
      originalSynopsis: original,
      targetLang: 'tr',
      timeoutMs: 20,
    });
    expect(timeoutRes).toEqual({
      synopsis: original,
      source: 'fallback_en',
      translated: false,
    });

    const missingBindingRes = await translateSynopsisWithWorkersAi({
      ai: undefined,
      title: 'Dark',
      originalSynopsis: original,
      targetLang: 'tr',
    });
    expect(missingBindingRes).toEqual({
      synopsis: original,
      source: 'fallback_en',
      translated: false,
    });

    // Empty synopsis, invalid targetLang, short/unusable output, and clipped long output
    expect(
      await translateSynopsisWithWorkersAi({
        ai: { run: async () => 'unused' },
        title: 'Dark',
        originalSynopsis: '   ',
        targetLang: 'tr',
      }),
    ).toEqual({ synopsis: '', source: 'original', translated: false });

    expect(
      await translateSynopsisWithWorkersAi({
        ai: { run: async () => 'unused' },
        title: 'Dark',
        originalSynopsis: original,
        targetLang: 'invalid_lang',
      }),
    ).toEqual({ synopsis: original, source: 'fallback_en', translated: false });

    expect(
      await translateSynopsisWithWorkersAi({
        ai: { run: async () => ({ response: 'No.' }) },
        title: 'Dark',
        originalSynopsis: original,
        targetLang: 'tr',
      }),
    ).toEqual({ synopsis: original, source: 'fallback_en', translated: false });

    const longRes = await translateSynopsisWithWorkersAi({
      ai: { run: async () => 'A'.repeat(2_000) },
      title: 'Dark',
      originalSynopsis: original,
      targetLang: 'tr',
    });
    expect(longRes.translated).toBe(true);
    expect(longRes.synopsis.length).toBe(1_500);
    expect(longRes.synopsis.endsWith('…')).toBe(true);
  });
});
