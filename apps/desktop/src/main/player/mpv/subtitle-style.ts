import {
  normalizeSubtitleStyle,
  type SubtitleBgColor,
  type SubtitleEdgeStyle,
  type SubtitleFontSize,
  type SubtitleStyleConfig,
  type SubtitleTextColor,
  type SubtitleVerticalPosition,
} from '@elv/domain';
import type { MpvCommand } from './codec.ts';

const SUB_SCALE_BY_SIZE: Readonly<Record<SubtitleFontSize, number>> = Object.freeze({
  small: 0.78,
  medium: 1.0,
  large: 1.25,
  extraLarge: 1.55,
});

const SUB_COLOR_BY_TEXT: Readonly<Record<SubtitleTextColor, string>> = Object.freeze({
  white: '#FFFFFFFF',
  yellow: '#FFFFE066',
  cyan: '#FF66F0FF',
  green: '#FF80FF99',
});

const SUB_BACK_COLOR_BY_BG: Readonly<Record<SubtitleBgColor, string>> = Object.freeze({
  none: '#00000000',
  translucent: '#B8000000',
  opaque: '#F2000000',
});

const SUB_EDGE_BY_STYLE: Readonly<
  Record<SubtitleEdgeStyle, { readonly borderSize: number; readonly shadowOffset: number }>
> = Object.freeze({
  none: Object.freeze({ borderSize: 0, shadowOffset: 0 }),
  outline: Object.freeze({ borderSize: 2.5, shadowOffset: 0 }),
  dropShadow: Object.freeze({ borderSize: 1, shadowOffset: 2.5 }),
});

/** Default vertical position (`secondary-sub-pos`) for secondary subtitles at the top edge (`#402`). */
export const DEFAULT_SECONDARY_SUB_POS = 10;

const TOP_PRIMARY_SUB_POS_WITH_SECONDARY = 24;

const SUB_POS_BY_VERTICAL: Readonly<Record<SubtitleVerticalPosition, number>> = Object.freeze({
  bottom: 96,
  raised: 84,
  top: 12,
});

function resolvePrimarySubPos(
  verticalPosition: SubtitleVerticalPosition,
  secondaryActive: boolean,
): number {
  if (verticalPosition === 'top' && secondaryActive) {
    return TOP_PRIMARY_SUB_POS_WITH_SECONDARY;
  }
  return SUB_POS_BY_VERTICAL[verticalPosition];
}

function resolveMpvSubtitleStyle(style: SubtitleStyleConfig, secondaryActive = false) {
  const clean = normalizeSubtitleStyle(style);
  const edge = SUB_EDGE_BY_STYLE[clean.edgeStyle];
  return {
    subScale: SUB_SCALE_BY_SIZE[clean.fontSize],
    subColor: SUB_COLOR_BY_TEXT[clean.textColor],
    subBackColor: SUB_BACK_COLOR_BY_BG[clean.backgroundColor],
    subBorderSize: edge.borderSize,
    subShadowOffset: edge.shadowOffset,
    subPos: resolvePrimarySubPos(clean.verticalPosition, secondaryActive),
  };
}

/** Maps {@link SubtitleStyleConfig} to stringified mpv per-file `loadfile` options (`#32`, `#402`). */
export function subtitleStyleLoadOptions(
  style: SubtitleStyleConfig,
  secondaryActive = false,
): Record<string, string> {
  const resolved = resolveMpvSubtitleStyle(style, secondaryActive);
  return {
    'sub-scale': String(resolved.subScale),
    'sub-color': resolved.subColor,
    'sub-back-color': resolved.subBackColor,
    'sub-border-size': String(resolved.subBorderSize),
    'sub-shadow-offset': String(resolved.subShadowOffset),
    'sub-pos': String(resolved.subPos),
  };
}

/** Builds live mpv `set_property` commands for {@link SubtitleStyleConfig} with zero playback restart (`#32`, `#402`). */
export function subtitleStyleCommands(
  style: SubtitleStyleConfig,
  secondaryActive = false,
): readonly MpvCommand[] {
  const resolved = resolveMpvSubtitleStyle(style, secondaryActive);
  const commands: MpvCommand[] = [
    ['set_property', 'sub-scale', resolved.subScale],
    ['set_property', 'sub-color', resolved.subColor],
    ['set_property', 'sub-back-color', resolved.subBackColor],
    ['set_property', 'sub-border-size', resolved.subBorderSize],
    ['set_property', 'sub-shadow-offset', resolved.subShadowOffset],
    ['set_property', 'sub-pos', resolved.subPos],
  ];
  if (secondaryActive) {
    commands.push(['set_property', 'secondary-sub-pos', DEFAULT_SECONDARY_SUB_POS]);
  }
  return commands;
}

/** Builds live `sub-pos` / `secondary-sub-pos` separation commands when dual subtitles toggle at `top` (`#402`). */
export function subtitlePositionCommands(
  style: SubtitleStyleConfig,
  secondaryActive: boolean,
): readonly MpvCommand[] {
  const clean = normalizeSubtitleStyle(style);
  const subPos = resolvePrimarySubPos(clean.verticalPosition, secondaryActive);
  return secondaryActive
    ? [
        ['set_property', 'secondary-sub-pos', DEFAULT_SECONDARY_SUB_POS],
        ['set_property', 'sub-pos', subPos],
      ]
    : [['set_property', 'sub-pos', subPos]];
}
