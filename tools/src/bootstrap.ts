/** True when dotted version `actual` (optionally `v`-prefixed) is at least `minimum`. */
export function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(actual);
  const m = parse(minimum);
  for (let i = 0; i < Math.max(a.length, m.length); i++) {
    const diff = (a[i] ?? 0) - (m[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}
