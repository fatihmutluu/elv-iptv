import { AppShell, createLazyCatalog } from '@elv/features';
import { type AppLocale, createAppI18n } from '@elv/i18n';
import {
  ErrorBoundary,
  FONT_FAMILY_SANS,
  I18nProvider,
  THEME_PRESETS,
  type ThemePresetId,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { type ReactElement, useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  type TextStyle,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { DesignGallery } from './DesignGallery.tsx';
import { createWorkbenchCatalog } from './mock-catalog.ts';
import { createWorkbenchVideoHost } from './mock-video-host.tsx';
import {
  computeFittedFrame,
  deviceFamilyOf,
  getWorkbenchDevice,
  toggleDeviceOrientation,
  type WorkbenchDeviceFamily,
  type WorkbenchDeviceId,
  type WorkbenchMode,
} from './presets.ts';
import { WorkbenchInspector } from './WorkbenchInspector.tsx';

const TOPBAR_HEIGHT = 52;
const DRAWER_WIDTH = 272;
const SANS_FONT: TextStyle = FONT_FAMILY_SANS ? { fontFamily: FONT_FAMILY_SANS } : {};

const FAMILY_TARGETS: ReadonlyArray<{
  readonly family: WorkbenchDeviceFamily;
  readonly label: string;
  readonly defaultId: WorkbenchDeviceId;
}> = [
  { family: 'tv', label: 'TV', defaultId: 'tv' },
  { family: 'desktop', label: 'PC', defaultId: 'desktop' },
  { family: 'tablet', label: 'Tablet', defaultId: 'tablet-landscape' },
  { family: 'phone', label: 'Phone', defaultId: 'phone-portrait' },
];

function SegButton({
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

function ToolButton({
  label,
  active = false,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
}): ReactElement {
  return (
    <Pressable onPress={onPress} style={[styles.toolBtn, active ? styles.toolBtnActive : null]}>
      <Text style={[styles.toolBtnText, active ? styles.toolBtnTextActive : null]}>{label}</Text>
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
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const [deviceId, setDeviceId] = useState<WorkbenchDeviceId>('tv');
  const [mode, setMode] = useState<WorkbenchMode>('gallery');
  const [preset, setPreset] = useState<ThemePresetId>('obsidianCrimson');
  const [locale, setLocale] = useState<AppLocale>('en');
  const [fontScale, setFontScale] = useState<number>(1.0);
  const [reduceMotion, setReduceMotion] = useState<boolean>(false);
  const [showOverscan, setShowOverscan] = useState<boolean>(true);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(true);

  const device = getWorkbenchDevice(deviceId);
  const family = deviceFamilyOf(deviceId);
  const canRotate = family === 'phone' || family === 'tablet';
  const activePalette = THEME_PRESETS[preset];
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
  const stageWidth = Math.max(200, winWidth - (drawerOpen ? DRAWER_WIDTH : 0));
  const stageHeight = Math.max(200, winHeight - TOPBAR_HEIGHT);
  const fitted = isFluid
    ? null
    : computeFittedFrame({
        frameWidth: device.frameWidth as number,
        frameHeight: device.frameHeight as number,
        stageWidth,
        stageHeight,
        paddingX: 56,
        paddingY: 84,
      });

  const bezelWidth = family === 'tv' ? 6 : family === 'tablet' ? 10 : 9;
  const bezelRadius = family === 'tv' ? 12 : family === 'tablet' ? 22 : 32;
  const webStageBg: ViewStyle | undefined =
    Platform.OS === 'web'
      ? ({
          backgroundImage: 'radial-gradient(circle at 50% 18%, #121521 0%, #05060A 78%)',
        } as unknown as ViewStyle)
      : undefined;
  const webFrameShadow: ViewStyle | undefined =
    Platform.OS === 'web'
      ? ({
          boxShadow: '0 32px 96px rgba(0,0,0,0.82), 0 0 0 1px rgba(255,255,255,0.12)',
        } as unknown as ViewStyle)
      : undefined;

  const stageContent = (
    <I18nProvider i18n={i18n}>
      <ThemeProvider preset={preset} fontScale={fontScale} reduceMotion={reduceMotion}>
        <ViewportProvider value={device.viewport}>
          <TvRemoteProvider>
            <ErrorBoundary>
              {mode === 'gallery' ? (
                <DesignGallery />
              ) : (
                <AppShell catalog={catalog} videoHost={videoHost} />
              )}
            </ErrorBoundary>
          </TvRemoteProvider>
        </ViewportProvider>
      </ThemeProvider>
    </I18nProvider>
  );

  const scaledInnerStyle: ViewStyle | undefined =
    fitted !== null
      ? ({
          width: device.frameWidth as number,
          height: device.frameHeight as number,
          ...(fitted.scale < 1
            ? {
                transform: [{ scale: fitted.scale }],
                ...(Platform.OS === 'web' ? { transformOrigin: 'top left' } : {}),
              }
            : {}),
        } as unknown as ViewStyle)
      : undefined;

  return (
    <View style={styles.root}>
      <View style={styles.topbar}>
        <View style={styles.brandCluster}>
          <View style={[styles.brandMark, { backgroundColor: activePalette.accent }]}>
            <Text style={[styles.brandMarkText, { color: activePalette.accentContrast }]}>ELV</Text>
          </View>
          <Text style={styles.brandTitle}>ELV IPTV</Text>
          <View style={styles.brandBadge}>
            <Text style={styles.brandBadgeText}>Workbench</Text>
          </View>
        </View>

        <View style={styles.controlsRight}>
          <View style={styles.segmented}>
            <SegButton
              label="Design System"
              active={mode === 'gallery'}
              onPress={() => setMode('gallery')}
            />
            <SegButton label="Live App" active={mode === 'app'} onPress={() => setMode('app')} />
          </View>

          <View style={styles.segmented}>
            {FAMILY_TARGETS.map((item) => (
              <SegButton
                key={item.family}
                label={item.label}
                active={family === item.family}
                onPress={() => {
                  if (family !== item.family) setDeviceId(item.defaultId);
                }}
              />
            ))}
          </View>

          {canRotate ? (
            <ToolButton
              label="Rotate"
              onPress={() => setDeviceId((prev) => toggleDeviceOrientation(prev))}
            />
          ) : null}

          {family === 'tv' ? (
            <ToolButton
              label="5% Safe"
              active={showOverscan}
              onPress={() => setShowOverscan((v) => !v)}
            />
          ) : null}

          <ToolButton label="Tokens" active={drawerOpen} onPress={() => setDrawerOpen((v) => !v)} />
        </View>
      </View>

      <View style={styles.studioBody}>
        {drawerOpen ? (
          <WorkbenchInspector
            preset={preset}
            onSelectPreset={setPreset}
            locale={locale}
            onSelectLocale={switchLocale}
            fontScale={fontScale}
            onSelectFontScale={setFontScale}
            reduceMotion={reduceMotion}
            onToggleReduceMotion={() => setReduceMotion((v) => !v)}
            showOverscan={showOverscan}
            onToggleOverscan={() => setShowOverscan((v) => !v)}
            isTv={family === 'tv'}
            viewportLabel={isFluid ? 'Fluid' : `${device.frameWidth}×${device.frameHeight}`}
          />
        ) : null}

        <View style={[styles.stage, webStageBg]}>
          {isFluid ? (
            <View style={styles.fluidStage}>{stageContent}</View>
          ) : fitted ? (
            <View style={styles.frameColumn}>
              <View style={styles.frameMetaPill}>
                <Text style={styles.frameMetaText}>
                  {`${device.label} · ${device.frameWidth}×${device.frameHeight} · Fit ${fitted.fitPercent}%`}
                </Text>
              </View>
              <View
                style={[
                  styles.deviceFrame,
                  webFrameShadow,
                  {
                    width: fitted.width + bezelWidth * 2,
                    height: fitted.height + bezelWidth * 2,
                    borderWidth: bezelWidth,
                    borderRadius: bezelRadius,
                    backgroundColor: activePalette.bgCanvas,
                  },
                ]}
              >
                <View style={styles.frameInner}>
                  <View style={scaledInnerStyle}>{stageContent}</View>
                  {family === 'tv' && showOverscan ? (
                    <View
                      pointerEvents="none"
                      style={[
                        styles.overscanGuide,
                        {
                          top: Math.round(fitted.height * 0.05),
                          bottom: Math.round(fitted.height * 0.05),
                          left: Math.round(fitted.width * 0.05),
                          right: Math.round(fitted.width * 0.05),
                        },
                      ]}
                    />
                  ) : null}
                </View>
              </View>
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#05060A' },
  topbar: {
    minHeight: TOPBAR_HEIGHT,
    paddingVertical: 6,
    backgroundColor: '#0A0C12',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.07)',
    paddingHorizontal: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  brandCluster: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandMark: {
    width: 26,
    height: 26,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkText: { ...SANS_FONT, fontSize: 10.5, fontWeight: '800', letterSpacing: -0.4 },
  brandTitle: {
    ...SANS_FONT,
    color: '#F7F8FA',
    fontSize: 13.5,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  brandBadge: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
  },
  brandBadgeText: { ...SANS_FONT, color: '#8B95A8', fontSize: 11, fontWeight: '600' },
  controlsRight: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  segmented: {
    flexDirection: 'row',
    backgroundColor: '#121520',
    padding: 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    gap: 2,
  },
  segBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 5, alignItems: 'center' },
  segBtnActive: { backgroundColor: '#FFFFFF' },
  segText: { ...SANS_FONT, color: '#94A3B8', fontSize: 12, fontWeight: '600' },
  segTextActive: { color: '#090A0E', fontWeight: '700' },
  toolBtn: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#121520',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  toolBtnActive: {
    borderColor: 'rgba(255,255,255,0.32)',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  toolBtnText: { ...SANS_FONT, color: '#CBD5E1', fontSize: 12, fontWeight: '600' },
  toolBtnTextActive: { color: '#FFFFFF' },
  studioBody: { flex: 1, flexDirection: 'row', minHeight: 0 },
  stage: {
    flex: 1,
    minWidth: 0,
    backgroundColor: '#07090F',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  fluidStage: { flex: 1, width: '100%' },
  frameColumn: { alignItems: 'center', gap: 10 },
  frameMetaPill: {
    backgroundColor: 'rgba(14,17,26,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  frameMetaText: { ...SANS_FONT, color: '#94A3B8', fontSize: 11, fontVariant: ['tabular-nums'] },
  deviceFrame: { borderColor: '#1A1E29', overflow: 'hidden' },
  frameInner: { flex: 1, position: 'relative', overflow: 'hidden' },
  overscanGuide: {
    position: 'absolute',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: 'rgba(250, 204, 21, 0.55)',
  },
});
