import { FONT_FAMILY_SANS } from '@elv/ui-kit';
import type { ReactElement } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

/** Height of the Workbench top control strip. */
export const TOPBAR_HEIGHT = 52;
/** Width of the collapsible Workbench token inspector drawer. */
export const DRAWER_WIDTH = 272;

const SANS_FONT: TextStyle = FONT_FAMILY_SANS ? { fontFamily: FONT_FAMILY_SANS } : {};

/** Web-only radial backdrop applied to the Workbench device stage. */
export const WEB_STAGE_BG: ViewStyle | undefined =
  Platform.OS === 'web'
    ? ({
        backgroundImage: 'radial-gradient(circle at 50% 18%, #121521 0%, #05060A 78%)',
      } as unknown as ViewStyle)
    : undefined;

/** Web-only elevation shadow applied to simulated device bezels. */
export const WEB_FRAME_SHADOW: ViewStyle | undefined =
  Platform.OS === 'web'
    ? ({
        boxShadow: '0 32px 96px rgba(0,0,0,0.82), 0 0 0 1px rgba(255,255,255,0.12)',
      } as unknown as ViewStyle)
    : undefined;

/** Compact segmented or toolbar button used in the Workbench top bar. */
export function WorkbenchBarButton(props: {
  label: string;
  active?: boolean;
  variant?: 'seg' | 'tool';
  onPress: () => void;
}): ReactElement {
  const isTool = props.variant === 'tool';
  return (
    <Pressable
      onPress={props.onPress}
      style={[
        isTool ? workbenchShellStyles.toolBtn : workbenchShellStyles.segBtn,
        props.active
          ? isTool
            ? workbenchShellStyles.toolBtnActive
            : workbenchShellStyles.segBtnActive
          : null,
      ]}
    >
      <Text
        style={[
          isTool ? workbenchShellStyles.toolBtnText : workbenchShellStyles.segText,
          props.active
            ? isTool
              ? workbenchShellStyles.toolBtnTextActive
              : workbenchShellStyles.segTextActive
            : null,
        ]}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** StyleSheet shared by `WorkbenchShell` and `WorkbenchBarButton`. */
export const workbenchShellStyles = StyleSheet.create({
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
