import { createHash } from 'node:crypto';
import { ACCOUNTS, type Account } from './accounts.ts';

const MAC_PATTERN = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/;
const FLEX_DEMO_MAC = /^00:1A:79:AA:BB:[0-9A-F]{2}$/;
const FIXED_MAC_ACCOUNTS: Readonly<Record<string, 'demo' | 'expired'>> = {
  '00:1A:79:00:00:01': 'demo',
  '00:1A:79:00:00:02': 'expired',
};

/** Active Stalker session bound to a synthetic MAC and simulator account. */
export interface TokenSession {
  mac: string;
  account: Account;
  expireOnce: boolean;
}

/** Normalizes a raw or URL-encoded MAC string into uppercase `AA:BB:CC:DD:EE:FF`, or null if invalid. */
function normalizeMac(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const upper = decoded.trim().toUpperCase();
  return MAC_PATTERN.test(upper) ? upper : null;
}

/** Maps a synthetic simulator MAC to its simulator `Account`, or `undefined` when rejected/unknown. */
export function resolveStalkerAccount(rawMac: string | null | undefined): Account | undefined {
  const mac = normalizeMac(rawMac);
  if (mac === null) return undefined;
  let username: string | undefined = FIXED_MAC_ACCOUNTS[mac];
  if (username === undefined && FLEX_DEMO_MAC.test(mac)) username = 'demo';
  if (username === undefined) return undefined;
  return ACCOUNTS.find((a) => a.username === username);
}

/** Extracts the `mac` value from a `Cookie` header string, or null if absent. */
export function parseMacCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() === 'mac') {
      return normalizeMac(part.slice(eq + 1).trim());
    }
  }
  return null;
}

/** Extracts the bearer token from an `Authorization: Bearer <token>` header, or null if invalid. */
export function parseBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  return match ? (match[1] as string) : null;
}

function mintToken(mac: string, generation: number): string {
  const digest = createHash('sha256')
    .update(`elv-stalker-sim:${mac}:${generation}`)
    .digest('hex')
    .slice(0, 24);
  return `sim-stalker-${digest}`;
}

/** Per-simulator-instance Stalker token store supporting deterministic tokens and single-use expiry. */
export class StalkerSessionStore {
  readonly #tokens = new Map<string, TokenSession>();
  readonly #generations = new Map<string, number>();

  /** Issues a deterministic bearer token for a validated MAC and account. */
  issue(mac: string, account: Account, expireOnce: boolean): string {
    const gen = this.#generations.get(mac) ?? 0;
    const token = mintToken(mac, gen);
    this.#tokens.set(token, { mac, account, expireOnce });
    return token;
  }

  /**
   * Validates a bearer token (and optional MAC cookie). If the token was flagged `expireOnce`,
   * invalidates it on first use, increments the MAC generation, and returns `null` so the caller returns 401.
   */
  verify(token: string | null, cookieMac: string | null): TokenSession | null {
    if (token === null) return null;
    const session = this.#tokens.get(token);
    if (!session) return null;
    if (cookieMac !== null && cookieMac !== session.mac) return null;
    if (session.expireOnce) {
      this.#tokens.delete(token);
      this.#generations.set(session.mac, (this.#generations.get(session.mac) ?? 0) + 1);
      return null;
    }
    return session;
  }

  /** Resets all active tokens and generation counters. */
  clear(): void {
    this.#tokens.clear();
    this.#generations.clear();
  }
}
