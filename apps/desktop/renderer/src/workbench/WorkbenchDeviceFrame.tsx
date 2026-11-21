import { FONT_FAMILY_SANS } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import { Platform, StyleSheet, Text, type TextStyle, View, type ViewStyle } from 'react-native';
import type { FittedFrame, WorkbenchDeviceFamily } from './presets.ts';
import { WEB_FRAME_SHADOW } from './WorkbenchShellParts.tsx';

/** Props for the physical hardware bezel and safe-area chrome wrapper. */
export interface WorkbenchDeviceFrameProps {
  readonly family: WorkbenchDeviceFamily;
  readonly orientation: 'portrait' | 'landscape';
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly fitted: FittedFrame;
  readonly bgCanvas: string;
  readonly showOverscan: boolean;
  readonly children: ReactElement;
}

const SANS: TextStyle = FONT_FAMILY_SANS ? { fontFamily: FONT_FAMILY_SANS } : {};
const SIGNAL_HEIGHTS = [4, 6, 8, 10] as const;

function StatusBattery(): ReactElement {
  return (
    <View style={s.batteryWrap}>
      <View style={s.batteryBody}>
        <View style={s.batteryFill} />
      </View>
      <View style={s.batteryCap} />
    </View>
  );
}

function PhoneOverlay({ landscape }: { readonly landscape: boolean }): ReactElement {
  if (landscape) {
    return (
      <View pointerEvents="none" style={s.overlay}>
        <View style={s.islandL}>
          <View style={s.lens} />
        </View>
        <View style={s.homeL} />
      </View>
    );
  }
  return (
    <View pointerEvents="none" style={s.overlay}>
      <View style={s.phoneBar}>
        <Text style={s.time}>9:41</Text>
        <View style={s.statusRight}>
          <View style={s.signal}>
            {SIGNAL_HEIGHTS.map((h) => (
              <View key={h} style={[s.sigBar, { height: h }]} />
            ))}
          </View>
          <StatusBattery />
        </View>
      </View>
      <View style={s.islandP}>
        <View style={s.lens} />
      </View>
      <View style={s.homeP} />
    </View>
  );
}

function TabletOverlay(): ReactElement {
  return (
    <View pointerEvents="none" style={s.overlay}>
      <View style={s.tabletBar}>
        <Text style={s.tabletTime}>9:41</Text>
        <StatusBattery />
      </View>
      <View style={s.tabletHome} />
    </View>
  );
}

/**
 * Renders authentic physical hardware chrome (titanium phone bezel with pill camera cutout,
 * slim glass tablet bezel, or cinema TV bezel) around the scaled Workbench stage.
 * All hardware chrome overlays set `pointerEvents="none"` so app input is never blocked.
 */
export function WorkbenchDeviceFrame(props: WorkbenchDeviceFrameProps): ReactElement {
  const { family, orientation, frameWidth, frameHeight, fitted, bgCanvas, showOverscan } = props;
  const isPhone = family === 'phone';
  const isTablet = family === 'tablet';
  const isTv = family === 'tv';
  const isLandscape = orientation === 'landscape';

  const bezel = isPhone ? 11 : isTablet ? 10 : 6;
  const outerRadius = isPhone ? 50 : isTablet ? 24 : 10;
  const innerRadius = Math.max(4, outerRadius - bezel);

  const scaledInnerStyle: ViewStyle = {
    width: frameWidth,
    height: frameHeight,
    position: 'relative',
    ...(fitted.scale < 1
      ? {
          transform: [{ scale: fitted.scale }],
          ...(Platform.OS === 'web' ? { transformOrigin: 'top left' } : {}),
        }
      : {}),
  } as unknown as ViewStyle;

  return (
    <View style={s.anchor}>
      {isPhone && !isLandscape ? (
        <View pointerEvents="none" style={s.sideBtns}>
          <View style={[s.btnL, { top: '16%', height: 22 }]} />
          <View style={[s.btnL, { top: '24%', height: 42 }]} />
          <View style={[s.btnL, { top: '33%', height: 42 }]} />
          <View style={[s.btnR, { top: '26%', height: 62 }]} />
        </View>
      ) : null}

      <View
        style={[
          s.bezel,
          WEB_FRAME_SHADOW,
          {
            width: fitted.width + bezel * 2,
            height: fitted.height + bezel * 2,
            borderRadius: outerRadius,
            padding: bezel,
            backgroundColor: isPhone ? '#1C1F26' : isTablet ? '#161922' : '#11141B',
          },
        ]}
      >
        <View
          style={[
            s.screen,
            {
              width: fitted.width,
              height: fitted.height,
              borderRadius: innerRadius,
              backgroundColor: bgCanvas,
            },
          ]}
        >
          <View style={scaledInnerStyle}>
            {props.children}
            {isPhone ? <PhoneOverlay landscape={isLandscape} /> : null}
            {isTablet ? <TabletOverlay /> : null}
            {isTv && showOverscan ? (
              <View
                pointerEvents="none"
                style={[
                  s.overscan,
                  {
                    top: Math.round(frameHeight * 0.05),
                    bottom: Math.round(frameHeight * 0.05),
                    left: Math.round(frameWidth * 0.05),
                    right: Math.round(frameWidth * 0.05),
                  },
                ]}
              />
            ) : null}
          </View>
        </View>

        {isTablet ? <View pointerEvents="none" style={s.tabCam} /> : null}
        {isTv ? <View pointerEvents="none" style={s.tvLed} /> : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  anchor: { position: 'relative', alignItems: 'center', justifyContent: 'center' },
  sideBtns: { position: 'absolute', top: 0, bottom: 0, left: -3, right: -3 },
  btnL: { position: 'absolute', left: 0, width: 3, borderRadius: 2, backgroundColor: '#2E333F' },
  btnR: { position: 'absolute', right: 0, width: 3, borderRadius: 2, backgroundColor: '#2E333F' },
  bezel: {
    position: 'relative',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  screen: {
    position: 'relative',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.65)',
  },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  phoneBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 54,
    paddingHorizontal: 28,
    paddingTop: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  time: {
    ...SANS,
    color: 'rgba(255,255,255,0.92)',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.2,
    fontVariant: ['tabular-nums'],
  },
  statusRight: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  signal: { flexDirection: 'row', alignItems: 'flex-end', gap: 1.5 },
  sigBar: { width: 2.5, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.88)' },
  batteryWrap: { flexDirection: 'row', alignItems: 'center', gap: 1.5 },
  batteryBody: {
    width: 22,
    height: 11,
    borderRadius: 3,
    borderWidth: 1.2,
    borderColor: 'rgba(255,255,255,0.75)',
    padding: 1.5,
  },
  batteryFill: { flex: 1, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.92)' },
  batteryCap: { width: 1.5, height: 4, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.6)' },
  islandP: {
    position: 'absolute',
    top: 11,
    left: '50%',
    marginLeft: -61,
    width: 122,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#050608',
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingRight: 11,
  },
  islandL: {
    position: 'absolute',
    left: 11,
    top: '50%',
    marginTop: -61,
    width: 34,
    height: 122,
    borderRadius: 17,
    backgroundColor: '#050608',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 11,
  },
  lens: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#131A2A',
    borderWidth: 1,
    borderColor: 'rgba(96,130,210,0.35)',
  },
  homeP: {
    position: 'absolute',
    bottom: 8,
    left: '50%',
    marginLeft: -67,
    width: 134,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.42)',
  },
  homeL: {
    position: 'absolute',
    bottom: 6,
    left: '50%',
    marginLeft: -90,
    width: 180,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.42)',
  },
  tabletBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 24,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  tabletTime: { ...SANS, color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '600' },
  tabletHome: {
    position: 'absolute',
    bottom: 7,
    left: '50%',
    marginLeft: -67,
    width: 134,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.36)',
  },
  tabCam: {
    position: 'absolute',
    top: 3,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#293246',
  },
  tvLed: {
    position: 'absolute',
    bottom: 2,
    width: 24,
    height: 2,
    borderRadius: 1,
    backgroundColor: 'rgba(255,255,255,0.32)',
  },
  overscan: {
    position: 'absolute',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: 'rgba(250, 204, 21, 0.55)',
  },
});
