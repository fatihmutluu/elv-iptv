import { ACCOUNTS } from './accounts.ts';
import { FaultParseError, parseFaults } from './faults.ts';

/** A rule as `GET /_sim/faults` lists it; `remaining` is null for an unlimited rule. */
export interface FaultRuleView {
  id: string;
  account: string;
  stream: string;
  spec: string;
  remaining: number | null;
}

/** The rule a request took: its id and the fault spec it applies. */
export interface AppliedRule {
  id: string;
  spec: string;
}

/** Result of `FaultRules.add`: the new rule id, or why the input was refused. */
export type AddResult = { ok: true; id: string } | { ok: false; error: string };

const BAD_STREAM = 'stream must be "*" or a stream id';

function parseStream(value: unknown): string | null {
  if (value === '*') return '*';
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return String(value);
  return null;
}

/** In-memory runtime fault rules: they attach a fault spec to the streams of one account. */
export class FaultRules {
  readonly #rules: FaultRuleView[] = [];
  #next = 1;

  /** Validates `input` (the parsed POST body) and stores a rule; ids are `r1`, `r2`, ... and never reused. */
  add(input: unknown): AddResult {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { ok: false, error: 'body is not a JSON object' };
    }
    const body = input as Record<string, unknown>;
    const account = ACCOUNTS.find((a) => a.username === body.account);
    if (!account) return { ok: false, error: `unknown account "${String(body.account)}"` };
    const stream = parseStream(body.stream);
    if (stream === null) return { ok: false, error: BAD_STREAM };
    const spec = body.spec;
    if (typeof spec !== 'string' || spec === '') {
      return { ok: false, error: 'spec must be a non-empty fault spec' };
    }
    try {
      parseFaults(spec);
    } catch (error) {
      if (error instanceof FaultParseError) return { ok: false, error: error.message };
      throw error;
    }
    const count = body.count;
    if (count !== undefined && (!Number.isInteger(count) || (count as number) < 1)) {
      return { ok: false, error: 'count must be a positive integer' };
    }
    const id = `r${this.#next++}`;
    const limit = (count as number | undefined) ?? null;
    this.#rules.push({ id, account: account.username, stream, spec, remaining: limit });
    return { ok: true, id };
  }

  /** The live rules in creation order. */
  list(): FaultRuleView[] {
    return this.#rules.map(({ id, account, stream, spec, remaining }) => ({
      id,
      account,
      stream,
      spec,
      remaining,
    }));
  }

  /** Removes every rule; ids keep counting up. */
  clear(): void {
    this.#rules.length = 0;
  }

  /** Picks the newest rule matching the stream and consumes one count; null when none matches. */
  take(account: string, streamId: number): AppliedRule | null {
    for (let i = this.#rules.length - 1; i >= 0; i--) {
      const rule = this.#rules[i] as FaultRuleView;
      if (rule.account !== account) continue;
      if (rule.stream !== '*' && Number(rule.stream) !== streamId) continue;
      if (rule.remaining !== null) {
        rule.remaining -= 1;
        if (rule.remaining === 0) this.#rules.splice(i, 1);
      }
      return { id: rule.id, spec: rule.spec };
    }
    return null;
  }
}
