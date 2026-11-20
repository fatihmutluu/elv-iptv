import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { useFormFactor } from '../../form-factor';
import { resolveViewport, useViewport, ViewportProvider } from '../index';

describe('resolveViewport', () => {
  it('resolves TV to landscape, tv modality, 5% overscan, and normalized Android TV vs tvOS scale (#281)', () => {
    const tvos = resolveViewport({ isTV: true, os: 'ios', width: 1920, height: 1080 });
    expect(tvos.formFactor).toBe('tv');
    expect(tvos.orientation).toBe('landscape');
    expect(tvos.inputModality).toBe('tv');
    expect(tvos.overscan).toEqual({ x: 96, y: 54 });
    expect(tvos.columns).toEqual({ posterRail: 5.5, wideRail: 3.3, categoryGrid: 5 });
    expect(tvos.tvScale).toBe(1);

    const androidTv = resolveViewport({ isTV: true, os: 'android', width: 960, height: 540 });
    expect(androidTv.tvScale).toBe(0.5);
    expect(androidTv.overscan).toEqual({ x: 48, y: 27 });
  });

  it('distinguishes phone portrait/landscape and tablet portrait/landscape columns per spec', () => {
    const phoneP = resolveViewport({ isTV: false, os: 'ios', width: 390, height: 844 });
    expect(phoneP.formFactor).toBe('phone');
    expect(phoneP.orientation).toBe('portrait');
    expect(phoneP.inputModality).toBe('touch');
    expect(phoneP.columns).toEqual({ posterRail: 3.5, wideRail: 1.2, categoryGrid: 3 });

    const phoneL = resolveViewport({ isTV: false, os: 'ios', width: 844, height: 390 });
    expect(phoneL.formFactor).toBe('phone');
    expect(phoneL.orientation).toBe('landscape');
    expect(phoneL.columns).toEqual({ posterRail: 5.5, wideRail: 3.3, categoryGrid: 5 });

    const tabletP = resolveViewport({ isTV: false, os: 'android', width: 768, height: 1024 });
    expect(tabletP.formFactor).toBe('tablet');
    expect(tabletP.orientation).toBe('portrait');
    expect(tabletP.columns).toEqual({ posterRail: 3.5, wideRail: 2.3, categoryGrid: 3 });
  });

  it('resolves desktop pointer modality and adapts narrow desktop windows gracefully', () => {
    const wide = resolveViewport({ isTV: false, os: 'web', width: 1440, height: 900 });
    expect(wide.formFactor).toBe('desktop');
    expect(wide.inputModality).toBe('pointer');
    expect(wide.columns).toEqual({ posterRail: 5.5, wideRail: 3.3, categoryGrid: 5 });

    const narrow = resolveViewport({ isTV: false, os: 'web', width: 640, height: 600 });
    expect(narrow.columns).toEqual({ posterRail: 3.5, wideRail: 2.2, categoryGrid: 3 });
  });
});

function ViewportProbe() {
  const vp = useViewport();
  const ff = useFormFactor();
  return (
    <>
      <Text testID="ff">{ff}</Text>
      <Text testID="orient">{vp.orientation}</Text>
      <Text testID="modality">{vp.inputModality}</Text>
      <Text testID="wide">{String(vp.columns.wideRail)}</Text>
    </>
  );
}

describe('ViewportProvider', () => {
  it('propagates overrides to both useViewport() and legacy useFormFactor()', async () => {
    await render(
      <ViewportProvider
        value={{ formFactor: 'phone', orientation: 'portrait', width: 390, height: 844 }}
      >
        <ViewportProbe />
      </ViewportProvider>,
    );

    expect(screen.getByTestId('ff').props.children).toBe('phone');
    expect(screen.getByTestId('orient').props.children).toBe('portrait');
    expect(screen.getByTestId('modality').props.children).toBe('touch');
    expect(screen.getByTestId('wide').props.children).toBe('1.2');
  });
});
