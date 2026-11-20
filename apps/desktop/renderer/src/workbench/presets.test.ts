import { describe, expect, it } from 'vitest';
import { resolveGate } from '../gate/params.ts';
import {
  computeFittedFrame,
  deviceFamilyOf,
  getWorkbenchDevice,
  shouldMountWorkbench,
  toggleDeviceOrientation,
  WORKBENCH_DEVICES,
} from './presets.ts';

describe('workbench presets & dev gating', () => {
  it('never mounts Workbench in production builds or active --elv-gate= runs', () => {
    expect(shouldMountWorkbench({ isDev: false, hasElectronBridge: false })).toBe(false);
    expect(
      shouldMountWorkbench({ isDev: false, hasElectronBridge: true, search: '?workbench=1' }),
    ).toBe(false);
    const gate = resolveGate('?elv-gate=player', { gate: true });
    expect(gate).toBeDefined();
    expect(
      shouldMountWorkbench({
        isDev: true,
        hasGate: gate !== undefined,
        hasElectronBridge: false,
      }),
    ).toBe(false);
  });

  it('mounts Workbench in dev browser automatically when resolveGate returns undefined and in dev Electron only with ?workbench=1', () => {
    const noGate = resolveGate('', undefined);
    expect(noGate).toBeUndefined();
    expect(
      shouldMountWorkbench({
        isDev: true,
        hasGate: noGate !== undefined,
        hasElectronBridge: false,
      }),
    ).toBe(true);
    expect(shouldMountWorkbench({ isDev: true, hasElectronBridge: true })).toBe(false);
    expect(
      shouldMountWorkbench({ isDev: true, hasElectronBridge: true, search: '?workbench=0' }),
    ).toBe(false);
    expect(
      shouldMountWorkbench({ isDev: true, hasElectronBridge: true, search: '?workbench=1' }),
    ).toBe(true);
  });

  it('defines all 6 adaptive device presets matching TV, Phone, Tablet, and Desktop viewports', () => {
    expect(WORKBENCH_DEVICES.map((d) => d.id)).toEqual([
      'tv',
      'phone-portrait',
      'phone-landscape',
      'tablet-portrait',
      'tablet-landscape',
      'desktop',
    ]);
    const tv = getWorkbenchDevice('tv');
    expect(tv.viewport.formFactor).toBe('tv');
    expect(tv.viewport.inputModality).toBe('tv');
    expect(getWorkbenchDevice('phone-portrait').viewport.orientation).toBe('portrait');
    expect(getWorkbenchDevice('phone-landscape').viewport.orientation).toBe('landscape');
    expect(getWorkbenchDevice('desktop').frameWidth).toBe('fluid');
  });

  it('fits device frames inside the available stage without exceeding 100% scale or breaking aspect ratio', () => {
    const tvTight = computeFittedFrame({
      frameWidth: 1280,
      frameHeight: 720,
      stageWidth: 960,
      stageHeight: 600,
      paddingX: 48,
      paddingY: 72,
    });
    expect(tvTight.width).toBeLessThanOrEqual(960 - 48);
    expect(tvTight.height).toBeLessThanOrEqual(600 - 72);
    expect(tvTight.scale).toBeLessThan(1);
    expect(tvTight.fitPercent).toBe(Math.round(tvTight.scale * 100));
    expect(Math.abs(tvTight.width / tvTight.height - 16 / 9)).toBeLessThan(0.02);

    const phoneRoomy = computeFittedFrame({
      frameWidth: 390,
      frameHeight: 844,
      stageWidth: 1400,
      stageHeight: 1100,
    });
    expect(phoneRoomy.scale).toBe(1);
    expect(phoneRoomy.fitPercent).toBe(100);
    expect(phoneRoomy.width).toBe(390);
    expect(phoneRoomy.height).toBe(844);
  });

  it('toggles orientation only for phone and tablet device presets', () => {
    expect(toggleDeviceOrientation('phone-portrait')).toBe('phone-landscape');
    expect(toggleDeviceOrientation('phone-landscape')).toBe('phone-portrait');
    expect(toggleDeviceOrientation('tablet-portrait')).toBe('tablet-landscape');
    expect(toggleDeviceOrientation('tablet-landscape')).toBe('tablet-portrait');
    expect(toggleDeviceOrientation('tv')).toBe('tv');
    expect(toggleDeviceOrientation('desktop')).toBe('desktop');
  });

  it('maps every device preset id to its 4-way family bucket', () => {
    expect(deviceFamilyOf('tv')).toBe('tv');
    expect(deviceFamilyOf('desktop')).toBe('desktop');
    expect(deviceFamilyOf('tablet-portrait')).toBe('tablet');
    expect(deviceFamilyOf('tablet-landscape')).toBe('tablet');
    expect(deviceFamilyOf('phone-portrait')).toBe('phone');
    expect(deviceFamilyOf('phone-landscape')).toBe('phone');
  });
});
