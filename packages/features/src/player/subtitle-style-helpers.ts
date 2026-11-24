import {
  SUBTITLE_BG_COLORS,
  SUBTITLE_EDGE_STYLES,
  SUBTITLE_FONT_SIZES,
  SUBTITLE_TEXT_COLORS,
  SUBTITLE_VERTICAL_POSITIONS,
  type SubtitleBgColor,
  type SubtitleEdgeStyle,
  type SubtitleFontSize,
  type SubtitleStyleConfig,
  type SubtitleTextColor,
  type SubtitleVerticalPosition,
} from '@elv/domain';
import type { AppI18n, MessageId } from '@elv/i18n';
import { isAllowedExternalSubtitleUri } from '@elv/playback';

/** Editable style attributes shown in `SubtitleStyleSection` in focus order (`#32`). */
export const SUBTITLE_STYLE_FIELDS = [
  'fontSize',
  'textColor',
  'backgroundColor',
  'edgeStyle',
  'verticalPosition',
] as const;

/** One editable field of {@link SubtitleStyleConfig}. */
export type SubtitleStyleField = (typeof SUBTITLE_STYLE_FIELDS)[number];

/** Total focusable rows in `SubtitleStyleSection` (5 style attributes + Reset). */
export const SUBTITLE_STYLE_ROW_COUNT = SUBTITLE_STYLE_FIELDS.length + 1;

/** Localized label keys for {@link SubtitleFontSize}. */
export const SUBTITLE_FONT_SIZE_LABELS: Readonly<Record<SubtitleFontSize, MessageId>> = {
  small: 'player.subtitleStyle.sizeSmall',
  medium: 'player.subtitleStyle.sizeMedium',
  large: 'player.subtitleStyle.sizeLarge',
  extraLarge: 'player.subtitleStyle.sizeExtraLarge',
};

/** Localized label keys for {@link SubtitleTextColor}. */
export const SUBTITLE_TEXT_COLOR_LABELS: Readonly<Record<SubtitleTextColor, MessageId>> = {
  white: 'player.subtitleStyle.colorWhite',
  yellow: 'player.subtitleStyle.colorYellow',
  cyan: 'player.subtitleStyle.colorCyan',
  green: 'player.subtitleStyle.colorGreen',
};

/** Localized label keys for {@link SubtitleBgColor}. */
export const SUBTITLE_BG_COLOR_LABELS: Readonly<Record<SubtitleBgColor, MessageId>> = {
  none: 'player.subtitleStyle.bgNone',
  translucent: 'player.subtitleStyle.bgTranslucent',
  opaque: 'player.subtitleStyle.bgOpaque',
};

/** Localized label keys for {@link SubtitleEdgeStyle}. */
export const SUBTITLE_EDGE_STYLE_LABELS: Readonly<Record<SubtitleEdgeStyle, MessageId>> = {
  none: 'player.subtitleStyle.edgeNone',
  outline: 'player.subtitleStyle.edgeOutline',
  dropShadow: 'player.subtitleStyle.edgeDropShadow',
};

/** Localized label keys for {@link SubtitleVerticalPosition}. */
export const SUBTITLE_VERTICAL_POS_LABELS: Readonly<Record<SubtitleVerticalPosition, MessageId>> = {
  bottom: 'player.subtitleStyle.posBottom',
  raised: 'player.subtitleStyle.posRaised',
  top: 'player.subtitleStyle.posTop',
};

function cycleOption<T>(list: readonly T[], current: T, delta: -1 | 1): T {
  const idx = list.indexOf(current);
  const base = Math.max(idx, 0);
  const nextIdx = (base + delta + list.length) % list.length;
  return list[nextIdx] as T;
}

/** Cycles one field of {@link SubtitleStyleConfig} forward or backward by one preset (`#32`). */
export function stepSubtitleStyleField(
  style: SubtitleStyleConfig,
  field: SubtitleStyleField,
  delta: -1 | 1,
): SubtitleStyleConfig {
  switch (field) {
    case 'fontSize':
      return { ...style, fontSize: cycleOption(SUBTITLE_FONT_SIZES, style.fontSize, delta) };
    case 'textColor':
      return { ...style, textColor: cycleOption(SUBTITLE_TEXT_COLORS, style.textColor, delta) };
    case 'backgroundColor':
      return {
        ...style,
        backgroundColor: cycleOption(SUBTITLE_BG_COLORS, style.backgroundColor, delta),
      };
    case 'edgeStyle':
      return { ...style, edgeStyle: cycleOption(SUBTITLE_EDGE_STYLES, style.edgeStyle, delta) };
    case 'verticalPosition':
      return {
        ...style,
        verticalPosition: cycleOption(SUBTITLE_VERTICAL_POSITIONS, style.verticalPosition, delta),
      };
  }
}

/** Formats a concise summary string for the root Player Settings Subtitle style row (`#32`). */
export function formatSubtitleStyleSummary(style: SubtitleStyleConfig, i18n: AppI18n): string {
  const size = i18n.t(SUBTITLE_FONT_SIZE_LABELS[style.fontSize]);
  const color = i18n.t(SUBTITLE_TEXT_COLOR_LABELS[style.textColor]);
  return `${size} · ${color}`;
}

/** Validates that a user-entered external subtitle URL uses `http://` or `https://` and passes transport checks (`#32`, `#308`). */
export function isValidExternalSubtitleHttpUrl(raw: string): boolean {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;
  return isAllowedExternalSubtitleUri(trimmed);
}
