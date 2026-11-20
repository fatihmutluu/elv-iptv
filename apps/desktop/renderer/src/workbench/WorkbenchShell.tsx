import { AppShell, createLazyCatalog } from '@elv/features';
import { type AppLocale, createAppI18n } from '@elv/i18n';
import {
  ErrorBoundary,
  I18nProvider,
  THEME_PRESET_IDS,
  THEME_PRESETS,
  type ThemePresetId,
  ThemeProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { type ReactElement, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { DesignGallery } from './DesignGallery.tsx';
import { createWorkbenchCatalog } from './mock-catalog.ts';
import { createWorkbenchVideoHost } from './mock-video-host.tsx';
import {
  getWorkbenchDevice,
  WORKBENCH_DEVICES,
  type WorkbenchDeviceId,
  type WorkbenchMode,
} from './presets.ts';

const FONT_SCALES = [0.9, 1.0, 1.1, 1.2] as const;

function ToolbarPill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}): ReactElement {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.pill, active ? styles.pillActive : styles.pillIdle]}
    >
      <Text style={[styles.pillText, active ? styles.pillTextActive : styles.pillTextIdle]}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Dev-only multi-device hot-reload Workbench (`pnpm dev:ui`).
 * Never bundled in production (`__DEV__ === false`). Lets developers inspect real `@elv/ui-kit`
 * and `@elv/features` code across TV, Phone, Tablet, and Desktop frames, all 6 themes, TR/EN,
 * font scaling, reduce-motion, and TV 5% overscan safe-guides with Metro Fast Refresh.
 */
export function WorkbenchShell(): ReactElement {
  const [deviceId, setDeviceId] = useState<WorkbenchDeviceId>('tv');
  const [mode, setMode] = useState<WorkbenchMode>('gallery');
  const [preset, setPreset] = useState<ThemePresetId>('obsidianCrimson');
  const [locale, setLocale] = useState<AppLocale>('en');
  const [fontScale, setFontScale] = useState<number>(1.0);
  const [reduceMotion, setReduceMotion] = useState<boolean>(false);
  const [showOverscan, setShowOverscan] = useState<boolean>(true);

  const device = getWorkbenchDevice(deviceId);
  const i18n = useMemo(() => createAppI18n('en'), []);
  const catalog = useMemo(
    () => createLazyCatalog(() => Promise.resolve(createWorkbenchCatalog())),
    [],
  );
  const videoHost = useMemo(() => createWorkbenchVideoHost(), []);

  const switchLocale = (next: AppLocale) => {
    setLocale(next);
    i18n.setLocale(next);
  };

  const isFluid = device.frameWidth === 'fluid' || device.frameHeight === 'fluid';
  const stageFrameStyle = isFluid
    ? styles.fluidFrame
    : {
        width: device.frameWidth as number,
        height: device.frameHeight as number,
        borderRadius: device.id === 'tv' ? 8 : 22,
        borderWidth: 2,
        borderColor: '#2A2E3B',
        overflow: 'hidden' as const,
      };

  const stageContent = (
    <I18nProvider i18n={i18n}>
      <ThemeProvider preset={preset} fontScale={fontScale} reduceMotion={reduceMotion}>
        <ViewportProvider value={device.viewport}>
          <ErrorBoundary>
            {mode === 'gallery' ? (
              <DesignGallery />
            ) : (
              <AppShell catalog={catalog} videoHost={videoHost} />
            )}
          </ErrorBoundary>
        </ViewportProvider>
      </ThemeProvider>
    </I18nProvider>
  );

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.toolbarRow}
        >
          <Text style={styles.brand}>WORKBENCH</Text>
          <View style={styles.divider} />
          <ToolbarPill
            label="Design System"
            active={mode === 'gallery'}
            onPress={() => setMode('gallery')}
          />
          <ToolbarPill label="Live App" active={mode === 'app'} onPress={() => setMode('app')} />
          <View style={styles.divider} />
          {WORKBENCH_DEVICES.map((d) => (
            <ToolbarPill
              key={d.id}
              label={d.shortLabel}
              active={deviceId === d.id}
              onPress={() => setDeviceId(d.id)}
            />
          ))}
          <View style={styles.divider} />
          {THEME_PRESET_IDS.map((id) => (
            <ToolbarPill
              key={id}
              label={id === 'highContrast' ? 'AAA' : (THEME_PRESETS[id].label.split(' ')[0] ?? id)}
              active={preset === id}
              onPress={() => setPreset(id)}
            />
          ))}
          <View style={styles.divider} />
          <ToolbarPill label="EN" active={locale === 'en'} onPress={() => switchLocale('en')} />
          <ToolbarPill label="TR" active={locale === 'tr'} onPress={() => switchLocale('tr')} />
          <View style={styles.divider} />
          {FONT_SCALES.map((s) => (
            <ToolbarPill
              key={s}
              label={`${Math.round(s * 100)}%`}
              active={fontScale === s}
              onPress={() => setFontScale(s)}
            />
          ))}
          <View style={styles.divider} />
          <ToolbarPill
            label="Reduce Motion"
            active={reduceMotion}
            onPress={() => setReduceMotion((v) => !v)}
          />
          {device.id === 'tv' ? (
            <ToolbarPill
              label="5% Safe"
              active={showOverscan}
              onPress={() => setShowOverscan((v) => !v)}
            />
          ) : null}
        </ScrollView>
      </View>

      {isFluid ? (
        <View style={styles.fluidStage}>{stageContent}</View>
      ) : (
        <ScrollView style={styles.stageScroll} contentContainerStyle={styles.stageCenter}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.stageHoriz}
          >
            <View style={styles.frameColumn}>
              <Text style={styles.frameMeta}>
                {`${device.label} · ${device.frameWidth}×${device.frameHeight}`}
              </Text>
              <View style={[styles.frameWrap, stageFrameStyle]}>
                {stageContent}
                {device.id === 'tv' && showOverscan ? (
                  <View
                    pointerEvents="none"
                    style={[
                      styles.overscanGuide,
                      {
                        top: Math.round((device.frameHeight as number) * 0.05),
                        bottom: Math.round((device.frameHeight as number) * 0.05),
                        left: Math.round((device.frameWidth as number) * 0.05),
                        right: Math.round((device.frameWidth as number) * 0.05),
                      },
                    ]}
                  />
                ) : null}
              </View>
            </View>
          </ScrollView>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#050608',
  },
  toolbar: {
    height: 44,
    backgroundColor: '#111319',
    borderBottomWidth: 1,
    borderBottomColor: '#232734',
    justifyContent: 'center',
  },
  toolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 6,
  },
  brand: {
    color: '#F7F8FA',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  divider: {
    width: 1,
    height: 18,
    backgroundColor: '#2A2E3B',
    marginHorizontal: 4,
  },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    borderWidth: 1,
  },
  pillActive: {
    backgroundColor: '#FFFFFF',
    borderColor: '#FFFFFF',
  },
  pillIdle: {
    backgroundColor: '#191C26',
    borderColor: '#2A2E3B',
  },
  pillText: {
    fontSize: 11,
    fontWeight: '600',
  },
  pillTextActive: {
    color: '#09090B',
  },
  pillTextIdle: {
    color: '#C7CDD8',
  },
  fluidStage: {
    flex: 1,
  },
  fluidFrame: {
    flex: 1,
  },
  stageScroll: {
    flex: 1,
  },
  stageCenter: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 20,
  },
  stageHoriz: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  frameColumn: {
    alignItems: 'center',
    gap: 10,
  },
  frameMeta: {
    color: '#8D96A8',
    fontSize: 12,
  },
  frameWrap: {
    position: 'relative',
  },
  overscanGuide: {
    position: 'absolute',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(250, 204, 21, 0.45)',
  },
});
