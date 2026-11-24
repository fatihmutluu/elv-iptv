/** Supported user subtitle text size presets (`#32`). */
export const SUBTITLE_FONT_SIZES = ['small', 'medium', 'large', 'extraLarge'] as const;

/** User-selectable subtitle text size preset (`#32`). */
export type SubtitleFontSize = (typeof SUBTITLE_FONT_SIZES)[number];

/** Supported user subtitle foreground colors (`#32`). */
export const SUBTITLE_TEXT_COLORS = ['white', 'yellow', 'cyan', 'green'] as const;

/** User-selectable subtitle foreground color (`#32`). */
export type SubtitleTextColor = (typeof SUBTITLE_TEXT_COLORS)[number];

/** Supported user subtitle backdrop opacities (`#32`). */
export const SUBTITLE_BG_COLORS = ['none', 'translucent', 'opaque'] as const;

/** User-selectable subtitle backdrop opacity (`#32`). */
export type SubtitleBgColor = (typeof SUBTITLE_BG_COLORS)[number];

/** Supported user subtitle text edge treatments (`#32`). */
export const SUBTITLE_EDGE_STYLES = ['none', 'outline', 'dropShadow'] as const;

/** User-selectable subtitle text edge treatment (`#32`). */
export type SubtitleEdgeStyle = (typeof SUBTITLE_EDGE_STYLES)[number];

/** Supported user subtitle vertical placement presets (`#32`). */
export const SUBTITLE_VERTICAL_POSITIONS = ['bottom', 'raised', 'top'] as const;

/** User-selectable subtitle vertical placement preset (`#32`). */
export type SubtitleVerticalPosition = (typeof SUBTITLE_VERTICAL_POSITIONS)[number];

/** Cross-platform subtitle appearance configuration persisted in user preferences (`#32`). */
export interface SubtitleStyleConfig {
  readonly fontSize: SubtitleFontSize;
  readonly textColor: SubtitleTextColor;
  readonly backgroundColor: SubtitleBgColor;
  readonly edgeStyle: SubtitleEdgeStyle;
  readonly verticalPosition: SubtitleVerticalPosition;
}

/** Default Cinema Quietude subtitle appearance configuration (`#32`). */
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyleConfig = Object.freeze({
  fontSize: 'medium',
  textColor: 'white',
  backgroundColor: 'translucent',
  edgeStyle: 'outline',
  verticalPosition: 'bottom',
});

const FONT_SIZE_SET: ReadonlySet<string> = new Set(SUBTITLE_FONT_SIZES);
const TEXT_COLOR_SET: ReadonlySet<string> = new Set(SUBTITLE_TEXT_COLORS);
const BG_COLOR_SET: ReadonlySet<string> = new Set(SUBTITLE_BG_COLORS);
const EDGE_STYLE_SET: ReadonlySet<string> = new Set(SUBTITLE_EDGE_STYLES);
const VERTICAL_POS_SET: ReadonlySet<string> = new Set(SUBTITLE_VERTICAL_POSITIONS);

/** Type guard for {@link SubtitleFontSize}. */
export function isSubtitleFontSize(v: unknown): v is SubtitleFontSize {
  return typeof v === 'string' && FONT_SIZE_SET.has(v);
}

/** Type guard for {@link SubtitleTextColor}. */
export function isSubtitleTextColor(v: unknown): v is SubtitleTextColor {
  return typeof v === 'string' && TEXT_COLOR_SET.has(v);
}

/** Type guard for {@link SubtitleBgColor}. */
export function isSubtitleBgColor(v: unknown): v is SubtitleBgColor {
  return typeof v === 'string' && BG_COLOR_SET.has(v);
}

/** Type guard for {@link SubtitleEdgeStyle}. */
export function isSubtitleEdgeStyle(v: unknown): v is SubtitleEdgeStyle {
  return typeof v === 'string' && EDGE_STYLE_SET.has(v);
}

/** Type guard for {@link SubtitleVerticalPosition}. */
export function isSubtitleVerticalPosition(v: unknown): v is SubtitleVerticalPosition {
  return typeof v === 'string' && VERTICAL_POS_SET.has(v);
}

/** Normalizes an untrusted partial or full subtitle style object, filling missing/invalid fields with defaults. */
export function normalizeSubtitleStyle(raw: unknown): SubtitleStyleConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return DEFAULT_SUBTITLE_STYLE;
  }
  const obj = raw as Record<string, unknown>;
  const fontSize = isSubtitleFontSize(obj.fontSize)
    ? obj.fontSize
    : DEFAULT_SUBTITLE_STYLE.fontSize;
  const textColor = isSubtitleTextColor(obj.textColor)
    ? obj.textColor
    : DEFAULT_SUBTITLE_STYLE.textColor;
  const backgroundColor = isSubtitleBgColor(obj.backgroundColor)
    ? obj.backgroundColor
    : DEFAULT_SUBTITLE_STYLE.backgroundColor;
  const edgeStyle = isSubtitleEdgeStyle(obj.edgeStyle)
    ? obj.edgeStyle
    : DEFAULT_SUBTITLE_STYLE.edgeStyle;
  const verticalPosition = isSubtitleVerticalPosition(obj.verticalPosition)
    ? obj.verticalPosition
    : DEFAULT_SUBTITLE_STYLE.verticalPosition;
  if (
    fontSize === DEFAULT_SUBTITLE_STYLE.fontSize &&
    textColor === DEFAULT_SUBTITLE_STYLE.textColor &&
    backgroundColor === DEFAULT_SUBTITLE_STYLE.backgroundColor &&
    edgeStyle === DEFAULT_SUBTITLE_STYLE.edgeStyle &&
    verticalPosition === DEFAULT_SUBTITLE_STYLE.verticalPosition
  ) {
    return DEFAULT_SUBTITLE_STYLE;
  }
  return Object.freeze({ fontSize, textColor, backgroundColor, edgeStyle, verticalPosition });
}

/** Returns `true` when two {@link SubtitleStyleConfig} values are field-for-field equal. */
export function subtitleStyleEquals(a: SubtitleStyleConfig, b: SubtitleStyleConfig): boolean {
  return (
    a.fontSize === b.fontSize &&
    a.textColor === b.textColor &&
    a.backgroundColor === b.backgroundColor &&
    a.edgeStyle === b.edgeStyle &&
    a.verticalPosition === b.verticalPosition
  );
}

/** Merges an untrusted partial subtitle style patch onto a base config, keeping base fields on missing/invalid values. */
export function mergeSubtitleStyle(base: SubtitleStyleConfig, patch: unknown): SubtitleStyleConfig {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return base;
  }
  const obj = patch as Record<string, unknown>;
  const fontSize = isSubtitleFontSize(obj.fontSize) ? obj.fontSize : base.fontSize;
  const textColor = isSubtitleTextColor(obj.textColor) ? obj.textColor : base.textColor;
  const backgroundColor = isSubtitleBgColor(obj.backgroundColor)
    ? obj.backgroundColor
    : base.backgroundColor;
  const edgeStyle = isSubtitleEdgeStyle(obj.edgeStyle) ? obj.edgeStyle : base.edgeStyle;
  const verticalPosition = isSubtitleVerticalPosition(obj.verticalPosition)
    ? obj.verticalPosition
    : base.verticalPosition;
  const next: SubtitleStyleConfig = {
    fontSize,
    textColor,
    backgroundColor,
    edgeStyle,
    verticalPosition,
  };
  if (subtitleStyleEquals(next, DEFAULT_SUBTITLE_STYLE)) return DEFAULT_SUBTITLE_STYLE;
  if (subtitleStyleEquals(next, base)) return base;
  return Object.freeze(next);
}
