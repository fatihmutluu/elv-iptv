import { createMemoryPreferencesStore } from '@elv/domain';
import { AppProviders, AppShell } from '@elv/features';
import { type AppLocale, createAppI18n, resolveLocale } from '@elv/i18n';
import {
  ErrorBoundary,
  I18nProvider,
  isThemePresetId,
  THEME_PRESETS,
  type ThemePresetId,
  ThemeProvider,
  TvRemoteProvider,
  ViewportProvider,
} from '@elv/ui-kit';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { Platform, Text, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { DesignGallery } from './DesignGallery.tsx';
import { createWorkbenchCatalog } from './mock-catalog.ts';
import { createWorkbenchVideoHost } from './mock-video-host.tsx';
import {
  computeFittedFrame,
  deviceFamilyOf,
  getWorkbenchDevice,
  toggleDeviceOrientation,
  type WorkbenchDeviceId,
  type WorkbenchMode,
} from './presets.ts';
import {
  createWorkbenchRemoteCatalog,
  probeWorkbenchBridge,
  readWorkbenchBridgeConfig,
} from './remote-catalog.ts';
import { WorkbenchInspector } from './WorkbenchInspector.tsx';
import {
  DRAWER_WIDTH,
  persistDataMode,
  readInitialDataMode,
  workbenchShellStyles as styles,
  TOPBAR_HEIGHT,
  WEB_FRAME_SHADOW,
  WEB_STAGE_BG,
  WORKBENCH_FAMILY_TARGETS,
  WorkbenchBarButton,
  WorkbenchBridgeNotice,
  type WorkbenchBridgeStatus,
  type WorkbenchDataMode,
} from './WorkbenchShellParts.tsx';

/**
 * Dev-only multi-device hot-reload Workbench (`pnpm dev:ui`).
 * Never bundled in production (`__DEV__ === false`). Lets developers inspect real `@elv/ui-kit`
 * and `@elv/features` code across TV, Phone, Tablet, and Desktop frames, all 6 themes, TR/EN,
 * font scaling, reduce-motion, TV 5% overscan safe-guides, and Demo/Live catalog data.
 */
export function WorkbenchShell(): ReactElement {
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const bridgeConfig = useMemo(() => readWorkbenchBridgeConfig(), []);
  const demoCatalog = useMemo(() => createWorkbenchCatalog(), []);
  const liveCatalog = useMemo(
    () => (bridgeConfig ? createWorkbenchRemoteCatalog(bridgeConfig) : null),
    [bridgeConfig],
  );
  const videoHost = useMemo(() => createWorkbenchVideoHost(), []);

  const [deviceId, setDeviceId] = useState<WorkbenchDeviceId>('tv');
  const [mode, setMode] = useState<WorkbenchMode>('gallery');
  const [dataMode, setDataMode] = useState<WorkbenchDataMode>(() =>
    readInitialDataMode(bridgeConfig !== null),
  );
  const [bridgeStatus, setBridgeStatus] = useState<WorkbenchBridgeStatus>(() =>
    bridgeConfig !== null ? 'checking' : 'offline',
  );
  const [retryProbe, setRetryProbe] = useState<number>(0);
  const [prefs, setPrefs] = useState<{
    preset: ThemePresetId;
    locale: AppLocale;
    fontScale: number;
    reduceMotion: boolean;
  }>({ preset: 'obsidianCrimson', locale: 'en', fontScale: 1.0, reduceMotion: false });
  const [showOverscan, setShowOverscan] = useState<boolean>(true);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(true);

  const device = getWorkbenchDevice(deviceId);
  const family = deviceFamilyOf(deviceId);
  const canRotate = family === 'phone' || family === 'tablet';
  const activePalette = THEME_PRESETS[prefs.preset];
  const i18n = useMemo(() => createAppI18n('en'), []);
  const preferencesStore = useMemo(
    () =>
      createMemoryPreferencesStore({
        themePreset: 'obsidianCrimson',
        locale: 'en',
        fontScale: 1.0,
        reduceMotion: false,
      }),
    [],
  );

  const selectDataMode = (next: WorkbenchDataMode): void => {
    if (next === dataMode) return;
    setBridgeStatus(next === 'live' && bridgeConfig !== null ? 'checking' : 'offline');
    setDataMode(next);
    persistDataMode(next);
  };

  useEffect(() => {
    if (dataMode !== 'live') return;
    if (bridgeConfig === null) {
      setBridgeStatus('offline');
      return;
    }
    let cancelled = false;
    setBridgeStatus('checking');
    void probeWorkbenchBridge(bridgeConfig).then((healthy) => {
      if (!cancelled) {
        setBridgeStatus(healthy ? 'ready' : 'offline');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dataMode, bridgeConfig, retryProbe]);

  useEffect(
    () =>
      preferencesStore.subscribe((snap) => {
        const nextLocale: AppLocale =
          snap.locale === 'system' ? 'en' : resolveLocale([snap.locale]);
        i18n.setLocale(nextLocale);
        setPrefs((prev) => ({
          preset: isThemePresetId(snap.themePreset) ? snap.themePreset : prev.preset,
          locale: nextLocale,
          fontScale: snap.fontScale,
          reduceMotion: snap.reduceMotion,
        }));
      }),
    [i18n, preferencesStore],
  );

  const applyPrefs = (patch: Partial<typeof prefs>) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
    if (patch.locale) i18n.setLocale(patch.locale);
    void preferencesStore.update({
      ...(patch.preset !== undefined ? { themePreset: patch.preset } : {}),
      ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
      ...(patch.fontScale !== undefined ? { fontScale: patch.fontScale } : {}),
      ...(patch.reduceMotion !== undefined ? { reduceMotion: patch.reduceMotion } : {}),
    });
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

  const renderAppStage = (): ReactElement => {
    if (dataMode === 'demo') {
      return (
        <AppProviders
          preferencesStore={preferencesStore}
          systemLocale="en"
          viewport={device.viewport}
        >
          <AppShell key="demo" catalog={demoCatalog} videoHost={videoHost} />
        </AppProviders>
      );
    }
    if (bridgeStatus === 'ready' && liveCatalog !== null) {
      return (
        <AppProviders
          preferencesStore={preferencesStore}
          systemLocale="en"
          viewport={device.viewport}
        >
          <AppShell key="live" catalog={liveCatalog} videoHost={videoHost} />
        </AppProviders>
      );
    }
    if (bridgeStatus === 'checking') {
      return <WorkbenchBridgeNotice status="checking" />;
    }
    return (
      <WorkbenchBridgeNotice
        status="offline"
        onRetry={() => setRetryProbe((n) => n + 1)}
        onSwitchToDemo={() => selectDataMode('demo')}
      />
    );
  };

  const stageContent =
    mode === 'gallery' ? (
      <I18nProvider i18n={i18n}>
        <ThemeProvider
          preset={prefs.preset}
          fontScale={prefs.fontScale}
          reduceMotion={prefs.reduceMotion}
        >
          <ViewportProvider value={device.viewport}>
            <TvRemoteProvider>
              <ErrorBoundary>
                <DesignGallery />
              </ErrorBoundary>
            </TvRemoteProvider>
          </ViewportProvider>
        </ThemeProvider>
      </I18nProvider>
    ) : (
      renderAppStage()
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

  const tvInputHint =
    family === 'tv' && mode === 'app' ? ' · TV remote keys (use PC frame to type URLs)' : '';

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
            <WorkbenchBarButton
              label="Design System"
              active={mode === 'gallery'}
              onPress={() => setMode('gallery')}
            />
            <WorkbenchBarButton
              label="Live App"
              active={mode === 'app'}
              onPress={() => setMode('app')}
            />
          </View>

          <View style={styles.segmented}>
            <WorkbenchBarButton
              label="Demo"
              active={dataMode === 'demo'}
              onPress={() => selectDataMode('demo')}
            />
            <WorkbenchBarButton
              label="Live"
              active={dataMode === 'live'}
              onPress={() => {
                selectDataMode('live');
                setMode('app');
              }}
            />
          </View>

          <View style={styles.segmented}>
            {WORKBENCH_FAMILY_TARGETS.map((item) => (
              <WorkbenchBarButton
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
            <WorkbenchBarButton
              variant="tool"
              label="Rotate"
              onPress={() => setDeviceId((prev) => toggleDeviceOrientation(prev))}
            />
          ) : null}

          {family === 'tv' ? (
            <WorkbenchBarButton
              variant="tool"
              label="5% Safe"
              active={showOverscan}
              onPress={() => setShowOverscan((v) => !v)}
            />
          ) : null}

          <WorkbenchBarButton
            variant="tool"
            label="Tokens"
            active={drawerOpen}
            onPress={() => setDrawerOpen((v) => !v)}
          />
        </View>
      </View>

      <View style={styles.studioBody}>
        {drawerOpen ? (
          <WorkbenchInspector
            preset={prefs.preset}
            onSelectPreset={(preset) => applyPrefs({ preset })}
            locale={prefs.locale}
            onSelectLocale={(locale) => applyPrefs({ locale })}
            fontScale={prefs.fontScale}
            onSelectFontScale={(fontScale) => applyPrefs({ fontScale })}
            reduceMotion={prefs.reduceMotion}
            onToggleReduceMotion={() => applyPrefs({ reduceMotion: !prefs.reduceMotion })}
            showOverscan={showOverscan}
            onToggleOverscan={() => setShowOverscan((v) => !v)}
            isTv={family === 'tv'}
            viewportLabel={isFluid ? 'Fluid' : `${device.frameWidth}×${device.frameHeight}`}
          />
        ) : null}

        <View style={[styles.stage, WEB_STAGE_BG]}>
          {isFluid ? (
            <View style={styles.fluidStage}>{stageContent}</View>
          ) : fitted ? (
            <View style={styles.frameColumn}>
              <View style={styles.frameMetaPill}>
                <Text style={styles.frameMetaText}>
                  {`${device.label} · ${device.frameWidth}×${device.frameHeight} · Fit ${fitted.fitPercent}%${tvInputHint}`}
                </Text>
              </View>
              <View
                style={[
                  styles.deviceFrame,
                  WEB_FRAME_SHADOW,
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
