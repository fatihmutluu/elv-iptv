import { detectSegmentRules, hostOf, type SegmentRule } from './templates';

/** URLs of one host that settle its rules; a host judged on fewer is judged again when more of its URLs arrive. */
export const HOST_SAMPLE = 50;
const RULE_NAME = /^v(\d+)$/;

type Buckets = Map<string, string[]>;

const pair = (host: string, position: number): string => `${host}\n${position}`;

function maxBucketSize(buckets: Buckets | undefined): number {
  if (buckets === undefined) return 0;
  let max = 0;
  for (const list of buckets.values()) if (list.length > max) max = list.length;
  return max;
}

function addBucketUrl(buckets: Buckets, role: string, url: string, cap?: number): void {
  let list = buckets.get(role);
  if (list === undefined) {
    list = [];
    buckets.set(role, list);
  }
  if (cap === undefined || list.length < cap) list.push(url);
}

/**
 * Segment rules of one M3U import. Every import judges its hosts again: the first sample judges the hosts it
 * contains at least {@link HOST_SAMPLE} times, and any other host is judged on up to that many of its URLs while
 * the importer holds its entries back ({@link hold}, {@link settle}), so no entry is written before its host was
 * judged. Stream, logo and header URLs are bucketed separately per host so static logos on a stream host never
 * dilute stream token share while dedicated logo/referer hosts still settle their own rules.
 */
export class RuleBook {
  private readonly byHost = new Map<string, SegmentRule[]>();
  private readonly names = new Map<string, string>();
  private readonly settled = new Set<string>();
  private readonly open = new Map<string, Buckets>();
  private readonly pending = new Set<string>();
  private readonly seen = new Set<string>();
  private next = 0;
  /** Rules of every host, flattened; replaced whenever a judgement changes them. */
  rules: SegmentRule[] = [];

  constructor(stored: readonly SegmentRule[] = []) {
    for (const rule of stored) {
      let list = this.byHost.get(rule.host);
      if (list === undefined) {
        list = [];
        this.byHost.set(rule.host, list);
      }
      list.push(rule);
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
    this.startEntries(sample.map((url) => ({ url, role: 'stream' })));
  }

  /** Multi-role variant of {@link start} for stream, logo and header URLs of sampled entries. */
  startEntries(sample: readonly { url: string; role: string }[]): void {
    const groups = new Map<string, Buckets>();
    for (const item of sample) {
      const host = hostOf(item.url);
      if (host === undefined) continue;
      let buckets = groups.get(host);
      if (buckets === undefined) {
        buckets = new Map();
        groups.set(host, buckets);
      }
      addBucketUrl(buckets, item.role, item.url);
    }
    for (const [host, buckets] of groups) {
      if (maxBucketSize(buckets) < HOST_SAMPLE) continue;
      this.judgeBuckets(host, buckets);
      this.settled.add(host);
    }
    this.flatten();
  }

  /** Notes an entry URL; true when its host still collects URLs, so the entry must wait for {@link settle}. */
  hold(url: string, role = 'stream'): boolean {
    const host = hostOf(url);
    if (host === undefined) return false;
    this.seen.add(host);
    if (this.settled.has(host)) return false;
    let buckets = this.open.get(host);
    if (buckets === undefined) {
      buckets = new Map();
      this.open.set(host, buckets);
    }
    addBucketUrl(buckets, role, url, HOST_SAMPLE);
    this.pending.add(host);
    return true;
  }

  /** True when every host that holds entries back has collected {@link HOST_SAMPLE} URLs. */
  get ready(): boolean {
    for (const host of this.pending) {
      if (maxBucketSize(this.open.get(host)) < HOST_SAMPLE) return false;
    }
    return true;
  }

  /** Judges the hosts that hold entries back on what they collected and settles them. */
  settle(): void {
    for (const host of this.pending) {
      const buckets = this.open.get(host);
      if (buckets !== undefined) this.judgeBuckets(host, buckets);
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

  private judgeBuckets(host: string, buckets: Buckets): void {
    const positions = new Set<number>();
    let totalUrls = 0;
    for (const [, urls] of buckets) {
      totalUrls += urls.length;
      for (const r of detectSegmentRules(urls)) positions.add(r.position);
    }
    if (totalUrls === 0) return;
    if (totalUrls === 1) {
      for (const prev of this.byHost.get(host) ?? []) positions.add(prev.position);
    }
    const sorted = [...positions].sort((a, b) => a - b);
    this.byHost.set(
      host,
      sorted.map((position) => ({ host, position, name: this.nameOf(host, position) })),
    );
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
