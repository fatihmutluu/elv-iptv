import { createElement, type ReactElement } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useUiAdapters } from '../adapters';
import { useTheme } from '../theme';
import { renderNativeVectorSpec } from './native-vector-renderer';
import { ICON_PATHS, type IconName, type IconShape } from './paths';

/** Props of {@link Icon}. */
export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  accessibilityLabel?: string;
  testID?: string;
}

function renderWebShape(shape: IconShape, key: number, filled: boolean, strokeWidth: number) {
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
 * Cross-platform vector icon reading shapes from {@link ICON_PATHS}.
 * Renders crisp inline `<svg>` on web, delegates to `UiAdapters.renderSvg` on native when provided,
 * and falls back to a minimal themed placeholder box when no native SVG adapter is mounted.
 */
export function Icon({
  name,
  size = 20,
  color,
  strokeWidth = 1.8,
  accessibilityLabel,
  testID,
}: IconProps): ReactElement {
  const theme = useTheme();
  const adapters = useUiAdapters();
  const spec = ICON_PATHS[name];
  const resolvedColor = color ?? theme.colors.textPrimary;

  if (adapters.renderSvg) {
    return (
      <View
        testID={testID}
        accessible={accessibilityLabel !== undefined}
        accessibilityLabel={accessibilityLabel}
        style={[styles.box, { width: size, height: size }]}
      >
        {adapters.renderSvg({ spec, size, color: resolvedColor, strokeWidth })}
      </View>
    );
  }

  if (Platform.OS === 'web') {
    const filled = Boolean(spec.filled);
    return (
      <View
        testID={testID}
        accessible={accessibilityLabel !== undefined}
        accessibilityLabel={accessibilityLabel}
        style={[styles.box, { width: size, height: size }]}
      >
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
            style: { color: resolvedColor, display: 'block' },
            'aria-hidden': accessibilityLabel === undefined,
          },
          spec.shapes.map((shape, idx) => renderWebShape(shape, idx, filled, strokeWidth)),
        )}
      </View>
    );
  }

  return (
    <View
      testID={testID}
      accessible={accessibilityLabel !== undefined}
      accessibilityLabel={accessibilityLabel}
      style={[styles.box, { width: size, height: size }]}
    >
      {renderNativeVectorSpec({ spec, size, color: resolvedColor, strokeWidth })}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
