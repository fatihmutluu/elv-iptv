import { detectSegmentRules, hostOf, type SegmentRule } from './templates';

/** URLs of one host that settle its rules; a host judged on fewer is judged again when more of its URLs arrive. */
export const HOST_SAMPLE = 50;
const MIN_URLS = 2;
const RULE_NAME = /^v(\d+)$/;

const pair = (host: string, position: number): string => `${host}\n${position}`;

/**
 * Segment rules of one M3U import. Every import judges its hosts again: the first sample judges the hosts it
 * contains at least {@link HOST_SAMPLE} times, and any other host is judged on up to that many of its URLs while
 * the importer holds its entries back ({@link hold}, {@link settle}), so no entry is written before its host was
 * judged. Each host is judged once per run; the judgement replaces its stored rules (a host judged on fewer than
 * two URLs keeps them). A (host, position) pair keeps its stored name; a new pair gets the next free `v<N>`.
 */
export class RuleBook {
  private readonly byHost = new Map<string, SegmentRule[]>();
  private readonly names = new Map<string, string>();
  private readonly settled = new Set<string>();
  private readonly open = new Map<string, string[]>();
  private readonly pending = new Set<string>();
  private readonly seen = new Set<string>();
  private next = 0;
  /** Rules of every host, flattened; replaced whenever a judgement changes them. */
  rules: SegmentRule[] = [];

  constructor(stored: readonly SegmentRule[] = []) {
    for (const rule of stored) {
      this.byHost.set(rule.host, [...(this.byHost.get(rule.host) ?? []), rule]);
      this.names.set(pair(rule.host, rule.position), rule.name);
      const n = RULE_NAME.exec(rule.name);
      if (n !== null) this.next = Math.max(this.next, Number(n[1]) + 1);
    }
    this.flatten();
  }

  /**
   * Judges and settles every host with at least {@link HOST_SAMPLE} URLs in the first sample. The others are
   * judged when their entries, the sample's included, pass through {@link hold}.
   */
  start(sample: readonly string[]): void {
    const groups = new Map<string, string[]>();
    for (const url of sample) {
      const host = hostOf(url);
      if (host === undefined) continue;
      const urls = groups.get(host);
      if (urls === undefined) groups.set(host, [url]);
      else urls.push(url);
    }
    for (const [host, urls] of groups) {
      if (urls.length < HOST_SAMPLE) continue;
      this.judge(host, urls);
      this.settled.add(host);
    }
    this.flatten();
  }

  /** Notes an entry URL; true when its host still collects URLs, so the entry must wait for {@link settle}. */
  hold(url: string): boolean {
    const host = hostOf(url);
    if (host === undefined) return false;
    this.seen.add(host);
    if (this.settled.has(host)) return false;
    const urls = this.open.get(host) ?? [];
    if (urls.length < HOST_SAMPLE) urls.push(url);
    this.open.set(host, urls);
    this.pending.add(host);
    return true;
  }

  /** True when every host that holds entries back has collected {@link HOST_SAMPLE} URLs. */
  get ready(): boolean {
    for (const host of this.pending) {
      if ((this.open.get(host)?.length ?? 0) < HOST_SAMPLE) return false;
    }
    return true;
  }

  /** Judges the hosts that hold entries back on what they collected and settles them. */
  settle(): void {
    for (const host of this.pending) {
      this.judge(host, this.open.get(host) ?? []);
      this.open.delete(host);
      this.settled.add(host);
    }
    this.pending.clear();
    this.flatten();
  }

  /** Rules to store with a successful run: those of the hosts this run saw. */
  final(): SegmentRule[] {
    return this.rules.filter((rule) => this.seen.has(rule.host));
  }

  private judge(host: string, urls: readonly string[]): void {
    if (urls.length < MIN_URLS) return;
    const found = detectSegmentRules(urls).map((r) => ({
      host,
      position: r.position,
      name: this.nameOf(host, r.position),
    }));
    this.byHost.set(host, found);
  }

  private nameOf(host: string, position: number): string {
    const key = pair(host, position);
    let name = this.names.get(key);
    if (name === undefined) {
      name = `v${this.next}`;
      this.next += 1;
      this.names.set(key, name);
    }
    return name;
  }

  private flatten(): void {
    this.rules = [...this.byHost.values()].flat();
  }
}
