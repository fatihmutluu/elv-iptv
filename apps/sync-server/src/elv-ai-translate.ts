import type { WorkersAiBinding } from './elv-types.ts';
import { validateElvLang } from './elv-validation.ts';

/** Cloudflare Workers AI model used for one-time permanent synopsis translation. */
export const WORKERS_AI_TRANSLATION_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

const DEFAULT_AI_TIMEOUT_MS = 8_000;
const MAX_TRANSLATED_SYNOPSIS_CHARS = 1_500;
const MIN_TRANSLATED_SYNOPSIS_CHARS = 8;

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  tr: 'Turkish',
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  'pt-BR': 'Brazilian Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
  ar: 'Arabic',
  ja: 'Japanese',
  ko: 'Korean',
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
};

const PREFACE_RE =
  /^(?:here\s+is\s+(?:the\s+)?translation\s*:|translation\s*:|synopsis\s*:|t[üu]rk[çc]e\s+[çc]eviri\s*:|[öo]zet\s*:)\s*/i;

/** Returns true when `lang` is English (`en` or `en-*`), requiring zero AI translation. */
export function isEnglishLang(lang: string): boolean {
  const lower = lang.trim().toLowerCase();
  return lower === 'en' || lower.startsWith('en-');
}

/** Input parameters for `translateSynopsisWithWorkersAi`. */
export interface TranslateSynopsisParams {
  readonly ai?: WorkersAiBinding | undefined;
  readonly title: string;
  readonly originalSynopsis: string;
  readonly targetLang: string;
  readonly timeoutMs?: number;
}

/** Result of attempting Workers AI synopsis translation with clean fallback semantics. */
export interface TranslateSynopsisResult {
  readonly synopsis: string;
  readonly source: 'original' | 'workers_ai' | 'fallback_en';
  readonly translated: boolean;
}

function extractAiText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (raw === null || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.response === 'string') return rec.response;
  if (Array.isArray(rec.choices) && rec.choices.length > 0) {
    const first = rec.choices[0] as Record<string, unknown> | null;
    const msg = first?.message as Record<string, unknown> | null | undefined;
    if (typeof msg?.content === 'string') return msg.content;
  }
  return null;
}

function sanitizeTranslatedSynopsis(raw: string): string | null {
  let cleaned = raw
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  cleaned = cleaned.replace(PREFACE_RE, '').trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'")) ||
    (cleaned.startsWith('«') && cleaned.endsWith('»'))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (cleaned.length < MIN_TRANSLATED_SYNOPSIS_CHARS) return null;
  if (cleaned.length > MAX_TRANSLATED_SYNOPSIS_CHARS) {
    cleaned = `${cleaned.slice(0, MAX_TRANSLATED_SYNOPSIS_CHARS - 1).trimEnd()}…`;
  }
  return cleaned;
}

function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('WORKERS_AI_TIMEOUT'));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Translates an original IMDb synopsis into `targetLang` via Cloudflare Workers AI.
 * Skips AI for English locales and falls back gracefully to `originalSynopsis` on any error/timeout.
 */
export async function translateSynopsisWithWorkersAi(
  params: TranslateSynopsisParams,
): Promise<TranslateSynopsisResult> {
  const original = params.originalSynopsis.trim();
  if (original.length === 0) {
    return { synopsis: '', source: 'original', translated: false };
  }

  const validLang = validateElvLang(params.targetLang);
  if (!validLang.ok) {
    return { synopsis: original, source: 'fallback_en', translated: false };
  }
  const lang = validLang.value;
  if (isEnglishLang(lang)) {
    return { synopsis: original, source: 'original', translated: false };
  }
  if (!params.ai) {
    return { synopsis: original, source: 'fallback_en', translated: false };
  }

  const languageName = LANGUAGE_NAMES[lang] ?? LANGUAGE_NAMES[lang.slice(0, 2)] ?? lang;
  const safeTitle = params.title.trim().slice(0, 160);
  const clippedOriginal = original.slice(0, 1_200);
  const timeoutMs = params.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;

  const systemPrompt = `You are a professional cinema metadata translator. Translate the movie or TV show synopsis accurately and naturally into ${languageName}. Keep it spoiler-free, concise, and faithful to the original meaning. Output ONLY the translated synopsis as plain prose with no preamble, no quotes, and no notes.`;
  const userPrompt = `Title: ${safeTitle}\nSynopsis: ${clippedOriginal}`;

  try {
    const raw = await runWithTimeout(
      params.ai.run(WORKERS_AI_TRANSLATION_MODEL, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 280,
        temperature: 0.2,
      }),
      timeoutMs,
    );
    const extracted = extractAiText(raw);
    const sanitized = extracted ? sanitizeTranslatedSynopsis(extracted) : null;
    if (!sanitized) {
      return { synopsis: original, source: 'fallback_en', translated: false };
    }
    return { synopsis: sanitized, source: 'workers_ai', translated: true };
  } catch {
    return { synopsis: original, source: 'fallback_en', translated: false };
  }
}
