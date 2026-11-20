/** RGB triplet in the `0..255` range. */
export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Parses a `#RGB` or `#RRGGBB` hex string into RGB channels, throwing on invalid input. */
export function parseHexColor(hex: string): RgbColor {
  const raw = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    const r = Number.parseInt((raw[0] ?? '0') + (raw[0] ?? '0'), 16);
    const g = Number.parseInt((raw[1] ?? '0') + (raw[1] ?? '0'), 16);
    const b = Number.parseInt((raw[2] ?? '0') + (raw[2] ?? '0'), 16);
    return { r, g, b };
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16),
    };
  }
  throw new Error(`Invalid hex color: ${hex}`);
}

/** Converts a `#RGB` or `#RRGGBB` hex color and clamped `0..1` opacity to an `rgba(...)` CSS/RN string. */
export function hexToRgba(hex: string, alpha: number): string {
  const { r, g, b } = parseHexColor(hex);
  const clamped = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1));
  const rounded = Math.round(clamped * 1000) / 1000;
  return `rgba(${r}, ${g}, ${b}, ${rounded})`;
}

function linearizeChannel(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Computes WCAG 2.1 relative luminance (`0` black .. `1` white) of a hex color. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexColor(hex);
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
}

/** Computes the WCAG 2.1 contrast ratio (`1..21`) between two hex colors. */
export function contrastRatio(foregroundHex: string, backgroundHex: string): number {
  const l1 = relativeLuminance(foregroundHex);
  const l2 = relativeLuminance(backgroundHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
