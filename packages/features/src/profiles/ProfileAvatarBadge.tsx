import type { ProfileAvatarToken } from '@elv/data';
import {
  type IconShape,
  type IconSpec,
  renderNativeVectorSpec,
  useI18n,
  useTheme,
  useUiAdapters,
} from '@elv/ui-kit';
import { createElement, type ReactElement } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { getProfileAvatarPreset, resolveProfileAvatarColors } from './avatar-palette';

/** Size variant for {@link ProfileAvatarBadge}. */
export type ProfileAvatarSize = 'sm' | 'md' | 'lg' | 'xl';

/** Props of {@link ProfileAvatarBadge}. */
export interface ProfileAvatarBadgeProps {
  readonly name: string;
  readonly avatarToken: ProfileAvatarToken;
  readonly size?: ProfileAvatarSize;
  readonly isKids?: boolean;
  readonly showKidsPill?: boolean;
  readonly active?: boolean;
  readonly testID?: string;
}

interface AvatarDimensions {
  readonly box: number;
  readonly art: number;
  readonly strokeWidth: number;
}

const SIZE_MAP: Readonly<Record<ProfileAvatarSize, AvatarDimensions>> = {
  sm: { box: 28, art: 19, strokeWidth: 1.75 },
  md: { box: 44, art: 30, strokeWidth: 1.65 },
  lg: { box: 68, art: 46, strokeWidth: 1.55 },
  xl: { box: 112, art: 74, strokeWidth: 1.45 },
};

function renderWebVectorShape(shape: IconShape, key: number, filled: boolean, strokeWidth: number) {
  const fill = shape.fill ?? (filled ? 'currentColor' : 'none');
  const stroke = fill === 'currentColor' ? 'none' : 'currentColor';
  const sw = shape.strokeWidth ?? strokeWidth;

  if (shape.kind === 'path') {
    return createElement('path', { key, d: shape.d, fill, stroke, strokeWidth: sw });
  }
  if (shape.kind === 'circle') {
    return createElement('circle', {
      key,
      cx: shape.cx,
      cy: shape.cy,
      r: shape.r,
      fill,
      stroke,
      strokeWidth: sw,
    });
  }
  return createElement('rect', {
    key,
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
    rx: shape.rx,
    fill,
    stroke,
    strokeWidth: sw,
  });
}

/**
 * Renders any 24x24 {@link IconSpec} via `UiAdapters.renderSvg` when provided, inline `<svg>` on web,
 * or `@elv/ui-kit`'s native vector geometry renderer on iOS, iPadOS, tvOS, Android, Android TV, and Fire OS.
 */
export function VectorSpecGraphic({
  spec,
  size,
  color,
  strokeWidth = 1.65,
  testID,
}: {
  readonly spec: IconSpec;
  readonly size: number;
  readonly color: string;
  readonly strokeWidth?: number;
  readonly testID?: string;
}): ReactElement {
  const adapters = useUiAdapters();

  if (adapters.renderSvg) {
    return (
      <View testID={testID} style={[styles.vectorBox, { width: size, height: size }]}>
        {adapters.renderSvg({ spec, size, color, strokeWidth })}
      </View>
    );
  }

  if (Platform.OS === 'web') {
    const filled = Boolean(spec.filled);
    return (
      <View testID={testID} style={[styles.vectorBox, { width: size, height: size }]}>
        {createElement(
          'svg',
          {
            width: size,
            height: size,
            viewBox: spec.viewBox,
            fill: filled ? 'currentColor' : 'none',
            stroke: filled ? 'none' : 'currentColor',
            strokeWidth,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            style: { color, display: 'block' },
            'aria-hidden': true,
          },
          spec.shapes.map((shape, idx) => renderWebVectorShape(shape, idx, filled, strokeWidth)),
        )}
      </View>
    );
  }

  return (
    <View testID={testID} style={[styles.vectorBox, { width: size, height: size }]}>
      {renderNativeVectorSpec({ spec, size, color, strokeWidth })}
    </View>
  );
}

/**
 * Circular Cinema Quietude v2 illustrated local profile avatar (`#15`, `#506`).
 * Renders 9 distinct circular vector character motifs derived from theme tokens with zero hardcoded hex.
 */
export function ProfileAvatarBadge({
  name,
  avatarToken,
  size = 'md',
  isKids = false,
  showKidsPill = false,
  active = false,
  testID,
}: ProfileAvatarBadgeProps): ReactElement {
  const theme = useTheme();
  const i18n = useI18n();
  const dims = SIZE_MAP[size];
  const preset = getProfileAvatarPreset(avatarToken);
  const colors = resolveProfileAvatarColors(avatarToken, theme);

  return (
    <View testID={testID} accessibilityLabel={name} style={styles.wrap}>
      <View
        testID={testID ? `${testID}-circle` : undefined}
        style={[
          styles.circle,
          {
            width: dims.box,
            height: dims.box,
            borderRadius: theme.radius.pill,
            backgroundColor: colors.bg,
            borderWidth: active ? (size === 'xl' ? 3 : 2) : 1,
            borderColor: active ? theme.colors.focusRingColor : theme.colors.glassBorder,
          },
        ]}
      >
        <VectorSpecGraphic
          spec={preset.artwork}
          size={dims.art}
          color={colors.fg}
          strokeWidth={dims.strokeWidth}
          testID={testID ? `${testID}-art-${avatarToken}` : undefined}
        />
      </View>

      {isKids && showKidsPill ? (
        <View
          testID={testID ? `${testID}-kids` : undefined}
          style={[
            styles.kidsPill,
            {
              backgroundColor: theme.colors.bgElevated,
              borderColor: theme.colors.chipBorder,
              borderRadius: theme.radius.pill,
            },
          ]}
        >
          <Text style={[theme.typography.micro, { color: theme.colors.textPrimary }]}>
            {i18n.t('profiles.kidsBadge')}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  vectorBox: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  kidsPill: {
    marginTop: -8,
    paddingHorizontal: 7,
    paddingVertical: 1.5,
    borderWidth: 1,
  },
});
