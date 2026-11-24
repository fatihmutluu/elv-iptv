import { type ReactElement, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../theme';
import { encodeQrMatrix } from './qr-matrix';

const QUIET_ZONE_MODULES = 4;

// Documented camera-scannability exception to Cinema Quietude dark surface tokens:
// ISO/IEC 18004 QR scanners require a high-contrast light quiet zone and dark modules.
const QR_QUIET_ZONE_BG = '#FFFFFF';
const QR_DARK_MODULE_COLOR = '#000000';

/** Props for {@link QrCodeView}. */
export interface QrCodeViewProps {
  /** UTF-8 string payload to encode (up to 213 bytes for Version 10-M). */
  readonly value: string;
  /** Square display size in density-independent pixels (default `220`). */
  readonly size?: number;
  /** Optional test identifier for automated tests. */
  readonly testID?: string;
  /** Accessible label describing the QR code purpose. */
  readonly accessibilityLabel?: string;
}

interface DarkRun {
  readonly col: number;
  readonly length: number;
}

interface DarkRow {
  readonly row: number;
  readonly runs: readonly DarkRun[];
}

/**
 * Zero-dependency React Native QR code renderer (`#50`).
 * Renders crisp integer-sized `<View>` module runs inside a 4-module white quiet zone,
 * and falls back gracefully without throwing if `value` exceeds Version 10-M capacity.
 */
export function QrCodeView({
  value,
  size = 220,
  testID,
  accessibilityLabel,
}: QrCodeViewProps): ReactElement {
  const theme = useTheme();
  const matrix = useMemo(() => encodeQrMatrix(value), [value]);

  const rowRuns = useMemo<readonly DarkRow[]>(() => {
    if (matrix === null) return [];
    return matrix.modules.map((modules, row) => {
      const runs: DarkRun[] = [];
      let col = 0;
      while (col < modules.length) {
        if (!modules[col]) {
          col += 1;
          continue;
        }
        const start = col;
        while (col < modules.length && modules[col]) {
          col += 1;
        }
        runs.push({ col: start, length: col - start });
      }
      return { row, runs };
    });
  }, [matrix]);

  if (matrix === null) {
    return (
      <View
        testID={testID ? `${testID}-fallback` : undefined}
        accessibilityRole="image"
        accessibilityLabel={accessibilityLabel}
        style={[
          styles.fallback,
          {
            width: size,
            height: size,
            borderRadius: theme.radius.card,
            backgroundColor: theme.colors.bgSurface,
            borderColor: theme.colors.surfaceBorder,
          },
        ]}
      />
    );
  }

  const totalModules = matrix.size + QUIET_ZONE_MODULES * 2;
  const modulePx = Math.max(1, Math.floor(size / totalModules));
  const gridPx = matrix.size * modulePx;

  return (
    <View
      testID={testID}
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius: theme.radius.card,
        },
      ]}
    >
      <View style={{ width: gridPx, height: gridPx }}>
        {rowRuns.map(({ row, runs }) => (
          <View key={row} style={{ width: gridPx, height: modulePx, position: 'relative' }}>
            {runs.map((run) => (
              <View
                key={run.col}
                style={[
                  styles.module,
                  {
                    left: run.col * modulePx,
                    width: run.length * modulePx,
                    height: modulePx,
                  },
                ]}
              />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: QR_QUIET_ZONE_BG,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  module: {
    position: 'absolute',
    top: 0,
    backgroundColor: QR_DARK_MODULE_COLOR,
  },
  fallback: {
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
