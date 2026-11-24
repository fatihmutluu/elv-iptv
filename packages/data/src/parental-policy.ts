import { sha256Hex } from './credential-fingerprint';
import { foldText } from './fold';
import type { BrowseKind } from './queries-shared';
import { normalizeProfileId } from './user-state-helpers';

/** Default temporary parental unlock session timeout in minutes (`#31`). */
export const DEFAULT_PARENTAL_UNLOCK_TIMEOUT_MIN = 30;

/** Iterated SHA-256 rounds for pure-TS PIN hashing (`#31`). */
export const PIN_HASH_ITERATIONS = 10_000;

/** Maximum consecutive wrong PIN entries before temporary brute-force lockout (`#31`). */
export const MAX_PIN_ATTEMPTS = 5;

/** Temporary brute-force lockout duration in milliseconds after {@link MAX_PIN_ATTEMPTS} failures (`#31`). */
export const PIN_LOCKOUT_MS = 30_000;

/** Target granularity of a persisted parental lock (`#31`). */
export type ParentalLockTargetKind = 'category' | 'item';

/** Per-profile non-secret parental control policy persisted in SQLite (`parental_settings`). */
export interface ParentalSettings {
  readonly profileId: string;
  readonly enabled: boolean;
  readonly blockAdultKeywords: boolean;
  readonly maxRatingAge: number | null;
  readonly unlockTimeoutMin: number;
  readonly updatedAt: number;
}

/** Partial update patch accepted by `updateParentalSettings`. */
export interface UpdateParentalSettingsPatch {
  readonly enabled?: boolean;
  readonly blockAdultKeywords?: boolean;
  readonly maxRatingAge?: number | null;
  readonly unlockTimeoutMin?: number;
}

/** Persisted category or item parental lock row (`parental_locks`). */
export interface ParentalLockRecord {
  readonly profileId: string;
  readonly sourceId: string;
  readonly targetKind: ParentalLockTargetKind;
  readonly itemKind: BrowseKind;
  readonly targetKey: string;
  readonly createdAt: number;
}

/** Input identifying a category or item target for `setParentalLock`. */
export interface SetParentalLockInput {
  readonly profileId?: string;
  readonly sourceId: string;
  readonly targetKind: ParentalLockTargetKind;
  readonly itemKind: BrowseKind;
  readonly targetKey: string;
}

/** Optional filter criteria for `listParentalLocks`. */
export interface ParentalLockFilter {
  readonly sourceId?: string;
  readonly targetKind?: ParentalLockTargetKind;
  readonly itemKind?: BrowseKind;
}

/** Optional per-query profile & unlock override threaded into `@elv/data` queries (`#31`). */
export interface ParentalQueryOptions {
  readonly profileId?: string;
  readonly parentalUnlocked?: boolean;
}

/** Result returned by `verifyParentalPin` including rate-limit feedback (`#31`). */
export type PinVerifyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly remainingAttempts: number;
      readonly lockedUntilMs?: number;
    };

const PIN_RE = /^[0-9]{4,8}$/;
const SALT_HEX_RE = /^[0-9a-f]{32}$/i;
const STORED_PIN_RE = /^v1:([0-9a-f]{32}):([0-9a-f]{64})$/;

/** Strict token-boundary check for `18+` / `+18` markers before punctuation folding strips `+`. */
const ADULT_PLUS_18_RE = /(?:^|[^\p{L}\p{N}])(?:\+18|18\+)(?:$|[^\p{L}\p{N}])/u;

/** Folded single-token adult keywords (exact token match, zero substring false positives). */
const ADULT_TOKENS = new Set<string>([
  'xxx',
  'adult',
  'adults',
  'erotic',
  'erotica',
  'porn',
  'porno',
  'nsfw',
  'yetiskin',
]);

const RATING_AGE_MAP: Readonly<Record<string, number>> = {
  'TV-MA': 18,
  TVMA: 18,
  'NC-17': 18,
  NC17: 18,
  R: 18,
  X: 18,
  XXX: 18,
  '18+': 18,
  '+18': 18,
  '18': 18,
  '16+': 16,
  '+16': 16,
  '16': 16,
  'FSK 16': 16,
  'FSK-16': 16,
  '15+': 15,
  '+15': 15,
  '15': 15,
  'TV-14': 14,
  TV14: 14,
  '14+': 14,
  '+14': 14,
  '14': 14,
  'PG-13': 13,
  PG13: 13,
  '13+': 13,
  '+13': 13,
  '13': 13,
  '12+': 12,
  '+12': 12,
  '12': 12,
  '12A': 12,
  PG: 12,
  'FSK 12': 12,
  'FSK-12': 12,
  'TV-PG': 7,
  TVPG: 7,
  '7+': 7,
  '+7': 7,
  '7': 7,
  'TV-Y7': 7,
  'TV-Y7-FV': 7,
  G: 0,
  'TV-G': 0,
  TVG: 0,
  'TV-Y': 0,
  TVY: 0,
  U: 0,
  '0': 0,
  '0+': 0,
  ALL: 0,
};

const NUMERIC_AGE_RE = /^\+?(\d{1,2})\+?$/;

/** Returns the `SecretStore` key (`profile.<profileId>.pin`) for a profile's parental PIN hash. */
export function pinSecretKey(profileId?: string): string {
  return `profile.${normalizeProfileId(profileId)}.pin`;
}

/** Validates that `pin` is a 4 to 8 character ASCII digit string (`0-9`). */
export function isValidParentalPin(pin: unknown): pin is string {
  return typeof pin === 'string' && PIN_RE.test(pin);
}

function generateSaltHex(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj !== undefined && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const entropy = `${Date.now()}:${Math.random()}:${Math.random()}:${Math.random()}`;
  return sha256Hex(entropy).slice(0, 32);
}

/** Constant-time equality comparison for equal-length hex digests. */
export function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Hashes a 4..8 digit parental PIN with a 16-byte salt using 10,000 iterations of pure-TS SHA-256
 * (`v1:<32-hex-salt>:<64-hex-digest>`). Never persists plaintext PINs.
 */
export function hashParentalPin(pin: string, saltHex?: string): string {
  if (!isValidParentalPin(pin)) {
    throw new RangeError('Parental PIN must be 4 to 8 ASCII digits');
  }
  const salt =
    saltHex !== undefined
      ? SALT_HEX_RE.test(saltHex)
        ? saltHex.toLowerCase()
        : (() => {
            throw new RangeError('Invalid parental PIN salt');
          })()
      : generateSaltHex();
  let digest = sha256Hex(`elv-pin-v1:${salt}:${pin}`);
  for (let i = 1; i < PIN_HASH_ITERATIONS; i += 1) {
    digest = sha256Hex(`${salt}:${digest}`);
  }
  return `v1:${salt}:${digest}`;
}

/** Verifies a candidate PIN against a stored `v1:<salt>:<digest>` hash in constant time. */
export function verifyParentalPinHash(pin: string, stored: string): boolean {
  if (!isValidParentalPin(pin)) return false;
  const match = STORED_PIN_RE.exec(stored);
  if (match === null) return false;
  const salt = match[1] as string;
  const expectedDigest = match[2] as string;
  const computed = hashParentalPin(pin, salt);
  const computedDigest = computed.slice(3 + salt.length + 1);
  return constantTimeHexEqual(computedDigest, expectedDigest);
}

/**
 * Matches adult category/item/programme labels using strict token boundaries (`18+`, `+18`, `xxx`,
 * `adult`, `adults`, `erotic`, `erotica`, `porn`, `porno`, `nsfw`, `yetiskin`, `for adults`)
 * without triggering false positives on substrings such as `adultery` or `1800`.
 */
export function isAdultKeywordMatch(text: string): boolean {
  if (text === '') return false;
  if (ADULT_PLUS_18_RE.test(text)) return true;
  const folded = foldText(text);
  if (folded === '') return false;
  const tokens = folded.split(' ');
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] as string;
    if (ADULT_TOKENS.has(tok)) return true;
    if (tok === 'for' && tokens[i + 1] === 'adults') return true;
  }
  return false;
}

/**
 * Normalizes an XMLTV/broadcast parental rating label (e.g. `TV-MA`, `PG-13`, `16+`, `G`)
 * into a minimum age threshold (`0..18`), or `null` when unknown/unrated.
 */
export function parseRatingAge(ratingValue: string | null | undefined): number | null {
  if (typeof ratingValue !== 'string') return null;
  const trimmed = ratingValue.trim();
  if (trimmed === '') return null;
  const upper = trimmed.toUpperCase().replace(/\s+/g, ' ');
  if (Object.hasOwn(RATING_AGE_MAP, upper)) {
    return RATING_AGE_MAP[upper] as number;
  }
  const colonIdx = upper.lastIndexOf(':');
  if (colonIdx >= 0) {
    const suffix = upper.slice(colonIdx + 1).trim();
    if (Object.hasOwn(RATING_AGE_MAP, suffix)) {
      return RATING_AGE_MAP[suffix] as number;
    }
  }
  const numMatch = NUMERIC_AGE_RE.exec(upper);
  if (numMatch !== null) {
    const parsed = Number.parseInt(numMatch[1] as string, 10);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 21) return parsed;
  }
  return null;
}

interface AttemptState {
  failures: number;
  lockedUntilMs: number;
}

/** Per-profile in-memory PIN attempt brute-force limiter (`#31`). */
export interface PinAttemptLimiter {
  checkLocked(profileId: string, nowMs: number): PinVerifyResult | null;
  recordSuccess(profileId: string): PinVerifyResult;
  recordFailure(profileId: string, nowMs: number): PinVerifyResult;
  clear(profileId: string): void;
}

/** Creates an in-memory per-profile PIN rate limiter (`MAX_PIN_ATTEMPTS = 5`, `PIN_LOCKOUT_MS = 30s`). */
export function createPinAttemptLimiter(): PinAttemptLimiter {
  const states = new Map<string, AttemptState>();

  return {
    checkLocked(profileId, nowMs) {
      const key = normalizeProfileId(profileId);
      const state = states.get(key);
      if (state === undefined) return null;
      if (state.lockedUntilMs > nowMs) {
        return { ok: false, remainingAttempts: 0, lockedUntilMs: state.lockedUntilMs };
      }
      if (state.lockedUntilMs > 0) {
        states.delete(key);
      }
      return null;
    },

    recordSuccess(profileId) {
      states.delete(normalizeProfileId(profileId));
      return { ok: true };
    },

    recordFailure(profileId, nowMs) {
      const key = normalizeProfileId(profileId);
      const existing = states.get(key);
      const failures =
        existing !== undefined && existing.lockedUntilMs <= nowMs && existing.lockedUntilMs === 0
          ? existing.failures + 1
          : 1;
      if (failures >= MAX_PIN_ATTEMPTS) {
        const lockedUntilMs = nowMs + PIN_LOCKOUT_MS;
        states.set(key, { failures, lockedUntilMs });
        return { ok: false, remainingAttempts: 0, lockedUntilMs };
      }
      states.set(key, { failures, lockedUntilMs: 0 });
      return { ok: false, remainingAttempts: MAX_PIN_ATTEMPTS - failures };
    },

    clear(profileId) {
      states.delete(normalizeProfileId(profileId));
    },
  };
}
