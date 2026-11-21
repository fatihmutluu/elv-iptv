import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { FormFactorProvider, useFormFactor } from '../../form-factor';
import { resolveViewport, useViewport, ViewportProvider } from '../index';

describe('resolveViewport', () => {
  it('resolves TV to landscape, tv modality, 5% overscan, responsive density, and normalized Android TV vs tvOS scale (#281)', () => {
    const tvos = resolveViewport({ isTV: true, os: 'ios', width: 1920, height: 1080 });
    expect(tvos.formFactor).toBe('tv');
    expect(tvos.orientation).toBe('landscape');
    expect(tvos.inputModality).toBe('tv');
    expect(tvos.overscan).toEqual({ x: 96, y: 54 });
    expect(tvos.columns).toEqual({ posterRail: 7.4, wideRail: 5.3, categoryGrid: 7 });
    expect(tvos.tvScale).toBe(1);

    const tv720 = resolveViewport({ isTV: true, os: 'android', width: 1280, height: 720 });
    expect(tv720.columns).toEqual({ posterRail: 6.4, wideRail: 4.3, categoryGrid: 6 });

    const androidTv = resolveViewport({ isTV: true, os: 'android', width: 960, height: 540 });
    expect(androidTv.tvScale).toBe(0.5);
    expect(androidTv.overscan).toEqual({ x: 48, y: 27 });
    expect(androidTv.columns).toEqual({ posterRail: 6.4, wideRail: 4.3, categoryGrid: 6 });
  });

  it('distinguishes phone portrait/landscape and tablet portrait/landscape columns per responsive density', () => {
    const phoneP = resolveViewport({ isTV: false, os: 'ios', width: 393, height: 852 });
    expect(phoneP.formFactor).toBe('phone');
    expect(phoneP.orientation).toBe('portrait');
    expect(phoneP.inputModality).toBe('touch');
    expect(phoneP.columns).toEqual({ posterRail: 3.25, wideRail: 1.35, categoryGrid: 3 });

    const phoneL = resolveViewport({ isTV: false, os: 'ios', width: 852, height: 393 });
    expect(phoneL.formFactor).toBe('phone');
    expect(phoneL.orientation).toBe('landscape');
    expect(phoneL.columns).toEqual({ posterRail: 5.5, wideRail: 3.2, categoryGrid: 5 });

    const tabletP = resolveViewport({ isTV: false, os: 'ios', width: 834, height: 1194 });
    expect(tabletP.formFactor).toBe('tablet');
    expect(tabletP.orientation).toBe('portrait');
    expect(tabletP.columns).toEqual({ posterRail: 5.3, wideRail: 2.6, categoryGrid: 5 });

    const tabletL = resolveViewport({ isTV: false, os: 'ios', width: 1194, height: 834 });
    expect(tabletL.formFactor).toBe('tablet');
    expect(tabletL.orientation).toBe('landscape');
    expect(tabletL.columns).toEqual({ posterRail: 6.5, wideRail: 4.2, categoryGrid: 6 });
  });

  it('scales desktop column density smoothly across narrow, laptop, FHD, and ultrawide windows', () => {
    const narrow = resolveViewport({ isTV: false, os: 'web', width: 640, height: 600 });
    expect(narrow.formFactor).toBe('desktop');
    expect(narrow.inputModality).toBe('pointer');
    expect(narrow.columns).toEqual({ posterRail: 3.5, wideRail: 2.2, categoryGrid: 3 });

    const compact = resolveViewport({ isTV: false, os: 'web', width: 960, height: 700 });
    expect(compact.columns).toEqual({ posterRail: 5.3, wideRail: 3.3, categoryGrid: 5 });

    const smallLaptop = resolveViewport({ isTV: false, os: 'web', width: 1194, height: 800 });
    expect(smallLaptop.columns).toEqual({ posterRail: 6.4, wideRail: 4.2, categoryGrid: 6 });

    const hd1280 = resolveViewport({ isTV: false, os: 'web', width: 1280, height: 800 });
    expect(hd1280.columns).toEqual({ posterRail: 7.4, wideRail: 4.5, categoryGrid: 7 });

    const laptop1440 = resolveViewport({ isTV: false, os: 'web', width: 1440, height: 900 });
    expect(laptop1440.columns).toEqual({ posterRail: 8.4, wideRail: 5.3, categoryGrid: 8 });

    const fhd1920 = resolveViewport({ isTV: false, os: 'web', width: 1920, height: 1080 });
    expect(fhd1920.columns).toEqual({ posterRail: 10.4, wideRail: 6.3, categoryGrid: 10 });

    const qhd2560 = resolveViewport({ isTV: false, os: 'web', width: 2560, height: 1440 });
    expect(qhd2560.columns).toEqual({ posterRail: 11.4, wideRail: 7.3, categoryGrid: 11 });
  });
});

function ViewportProbe() {
  const vp = useViewport();
  const ff = useFormFactor();
  return (
    <>
      <Text testID="ff">{ff}</Text>
      <Text testID="vp-ff">{vp.formFactor}</Text>
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
    expect(screen.getByTestId('wide').props.children).toBe('1.35');
  });

  it('bridges legacy FormFactorProvider overrides into useViewport() when outside ViewportProvider', async () => {
    await render(
      <FormFactorProvider value="tv">
        <ViewportProbe />
      </FormFactorProvider>,
    );

    expect(screen.getByTestId('ff').props.children).toBe('tv');
    expect(screen.getByTestId('vp-ff').props.children).toBe('tv');
    expect(screen.getByTestId('orient').props.children).toBe('landscape');
    expect(screen.getByTestId('modality').props.children).toBe('tv');
    expect(screen.getByTestId('wide').props.children).toBe('4.3');
  });
});
