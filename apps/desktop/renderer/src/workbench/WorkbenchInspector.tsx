import type { AppLocale } from '@elv/i18n';
import {
  FONT_FAMILY_SANS,
  hexToRgba,
  THEME_PRESET_IDS,
  THEME_PRESETS,
  type ThemePresetId,
} from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, type TextStyle, View } from 'react-native';

const FONT_SCALES = [0.9, 1.0, 1.1, 1.2] as const;
const SANS_FONT: TextStyle = FONT_FAMILY_SANS ? { fontFamily: FONT_FAMILY_SANS } : {};

/** Props of {@link WorkbenchInspector}. */
export interface WorkbenchInspectorProps {
  readonly preset: ThemePresetId;
  readonly onSelectPreset: (id: ThemePresetId) => void;
  readonly locale: AppLocale;
  readonly onSelectLocale: (next: AppLocale) => void;
  readonly fontScale: number;
  readonly onSelectFontScale: (scale: number) => void;
  readonly reduceMotion: boolean;
  readonly onToggleReduceMotion: () => void;
  readonly showOverscan: boolean;
  readonly onToggleOverscan: () => void;
  readonly isTv: boolean;
  readonly viewportLabel: string;
}

function SegOption({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}): ReactElement {
  return (
    <Pressable onPress={onPress} style={[styles.segBtn, active ? styles.segBtnActive : null]}>
      <Text style={[styles.segText, active ? styles.segTextActive : null]}>{label}</Text>
    </Pressable>
  );
}

function ToggleRow({
  label,
  value,
  accent,
  onToggle,
}: {
  label: string;
  value: boolean;
  accent: string;
  onToggle: () => void;
}): ReactElement {
  return (
    <Pressable onPress={onToggle} style={styles.toggleRow}>
      <Text style={styles.ctrlLabel}>{label}</Text>
      <View style={[styles.switchTrack, value ? { backgroundColor: accent } : null]}>
        <View style={[styles.switchThumb, value ? styles.switchThumbOn : null]} />
      </View>
    </Pressable>
  );
}

/**
 * Collapsible 272px left Theme & Token Inspector drawer for the dev-only UI Workbench.
 */
export function WorkbenchInspector({
  preset,
  onSelectPreset,
  locale,
  onSelectLocale,
  fontScale,
  onSelectFontScale,
  reduceMotion,
  onToggleReduceMotion,
  showOverscan,
  onToggleOverscan,
  isTv,
  viewportLabel,
}: WorkbenchInspectorProps): ReactElement {
  const activePalette = THEME_PRESETS[preset];

  return (
    <ScrollView style={styles.drawer} contentContainerStyle={styles.drawerContent}>
      <View style={styles.drawerSection}>
        <Text style={styles.drawerHeading}>Theme Presets</Text>
        <View style={styles.presetList}>
          {THEME_PRESET_IDS.map((id) => {
            const p = THEME_PRESETS[id];
            const active = preset === id;
            return (
              <Pressable
                key={id}
                onPress={() => onSelectPreset(id)}
                style={[
                  styles.presetCard,
                  active
                    ? { borderColor: p.accent, backgroundColor: hexToRgba(p.accent, 0.14) }
                    : null,
                ]}
              >
                <View style={styles.swatchRow}>
                  <View style={[styles.swatch, { backgroundColor: p.bgCanvas }]} />
                  <View style={[styles.swatch, { backgroundColor: p.accent }]} />
                  <View style={[styles.swatch, { backgroundColor: p.textPrimary }]} />
                </View>
                <View style={styles.presetMeta}>
                  <Text numberOfLines={1} style={styles.presetName}>
                    {p.label}
                  </Text>
                  <Text numberOfLines={1} style={styles.presetDesc}>
                    {p.description}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.drawerSection}>
        <Text style={styles.drawerHeading}>Display & Accessibility</Text>
        <View style={styles.ctrlGroup}>
          <Text style={styles.ctrlLabel}>Language</Text>
          <View style={styles.segmented}>
            <SegOption label="TR" active={locale === 'tr'} onPress={() => onSelectLocale('tr')} />
            <SegOption label="EN" active={locale === 'en'} onPress={() => onSelectLocale('en')} />
          </View>
        </View>

        <View style={styles.ctrlGroup}>
          <Text style={styles.ctrlLabel}>Font Scale</Text>
          <View style={styles.segmented}>
            {FONT_SCALES.map((s) => (
              <SegOption
                key={s}
                label={`${Math.round(s * 100)}%`}
                active={fontScale === s}
                onPress={() => onSelectFontScale(s)}
              />
            ))}
          </View>
        </View>

        <ToggleRow
          label="Reduce Motion"
          value={reduceMotion}
          accent={activePalette.accent}
          onToggle={onToggleReduceMotion}
        />
        {isTv ? (
          <ToggleRow
            label="TV 5% Safe"
            value={showOverscan}
            accent={activePalette.accent}
            onToggle={onToggleOverscan}
          />
        ) : null}
      </View>

      <View style={styles.drawerSection}>
        <Text style={styles.drawerHeading}>Locked Design Specs</Text>
        <View style={styles.specList}>
          <View style={styles.specRow}>
            <Text style={styles.specKey}>Radius</Text>
            <Text style={styles.specVal}>4 / 6 / 12px</Text>
          </View>
          <View style={styles.specRow}>
            <Text style={styles.specKey}>Grid Gap</Text>
            <Text style={styles.specVal}>6px</Text>
          </View>
          <View style={styles.specRow}>
            <Text style={styles.specKey}>Focus Ring</Text>
            <Text style={styles.specVal}>{activePalette.highContrast ? '3px' : '2.5px'}</Text>
          </View>
          <View style={styles.specRow}>
            <Text style={styles.specKey}>Active Viewport</Text>
            <Text style={styles.specVal}>{viewportLabel}</Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  drawer: {
    width: 272,
    flexGrow: 0,
    flexShrink: 0,
    backgroundColor: '#0A0C12',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.07)',
  },
  drawerContent: { padding: 12, gap: 12 },
  drawerSection: {
    backgroundColor: '#10131C',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10,
    padding: 12,
    gap: 10,
  },
  drawerHeading: {
    ...SANS_FONT,
    color: '#8B95A8',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  presetList: { gap: 6 },
  presetCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    backgroundColor: '#0B0D14',
  },
  swatchRow: { flexDirection: 'row', gap: 3 },
  swatch: {
    width: 11,
    height: 11,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  presetMeta: { flex: 1, minWidth: 0, gap: 1 },
  presetName: { ...SANS_FONT, color: '#E2E8F0', fontSize: 12, fontWeight: '600' },
  presetDesc: { ...SANS_FONT, color: '#7C869B', fontSize: 10.5 },
  ctrlGroup: { gap: 6 },
  ctrlLabel: { ...SANS_FONT, color: '#CBD5E1', fontSize: 12, fontWeight: '500' },
  segmented: {
    width: '100%',
    flexDirection: 'row',
    backgroundColor: '#121520',
    padding: 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    gap: 2,
  },
  segBtn: {
    flex: 1,
    paddingHorizontal: 4,
    paddingVertical: 5,
    borderRadius: 5,
    alignItems: 'center',
  },
  segBtnActive: { backgroundColor: '#FFFFFF' },
  segText: { ...SANS_FONT, color: '#94A3B8', fontSize: 12, fontWeight: '600' },
  segTextActive: { color: '#090A0E', fontWeight: '700' },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  switchTrack: {
    width: 34,
    height: 19,
    borderRadius: 999,
    backgroundColor: '#1E2433',
    padding: 2,
    justifyContent: 'center',
  },
  switchThumb: { width: 15, height: 15, borderRadius: 999, backgroundColor: '#FFFFFF' },
  switchThumbOn: { alignSelf: 'flex-end' },
  specList: { gap: 6 },
  specRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  specKey: { ...SANS_FONT, color: '#94A3B8', fontSize: 11.5 },
  specVal: {
    ...SANS_FONT,
    color: '#E2E8F0',
    fontSize: 11,
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontVariant: ['tabular-nums'],
  },
});
