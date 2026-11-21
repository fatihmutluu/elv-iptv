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
    expect(tv.label).toBe('Living Room TV');
    expect(tv.frameWidth).toBe(1280);
    expect(tv.frameHeight).toBe(720);
    expect(tv.viewport.formFactor).toBe('tv');
    expect(tv.viewport.inputModality).toBe('tv');

    const phoneP = getWorkbenchDevice('phone-portrait');
    expect(phoneP.label).toBe('Phone Portrait');
    expect(phoneP.frameWidth).toBe(393);
    expect(phoneP.frameHeight).toBe(852);
    expect(phoneP.viewport.orientation).toBe('portrait');
    expect(phoneP.viewport.width).toBe(393);
    expect(phoneP.viewport.height).toBe(852);
    expect(phoneP.viewport.safeArea).toEqual({ top: 59, right: 0, bottom: 34, left: 0 });

    const phoneL = getWorkbenchDevice('phone-landscape');
    expect(phoneL.label).toBe('Phone Landscape');
    expect(phoneL.frameWidth).toBe(852);
    expect(phoneL.frameHeight).toBe(393);
    expect(phoneL.viewport.orientation).toBe('landscape');
    expect(phoneL.viewport.width).toBe(852);
    expect(phoneL.viewport.height).toBe(393);
    expect(phoneL.viewport.safeArea).toEqual({ top: 0, right: 59, bottom: 21, left: 59 });

    const tabP = getWorkbenchDevice('tablet-portrait');
    expect(tabP.label).toBe('Tablet Portrait');
    expect(tabP.frameWidth).toBe(834);
    expect(tabP.frameHeight).toBe(1194);
    expect(tabP.viewport.width).toBe(834);
    expect(tabP.viewport.height).toBe(1194);
    expect(tabP.viewport.safeArea).toEqual({ top: 24, right: 0, bottom: 20, left: 0 });

    const tabL = getWorkbenchDevice('tablet-landscape');
    expect(tabL.label).toBe('Tablet Landscape');
    expect(tabL.frameWidth).toBe(1194);
    expect(tabL.frameHeight).toBe(834);
    expect(tabL.viewport.width).toBe(1194);
    expect(tabL.viewport.height).toBe(834);
    expect(tabL.viewport.safeArea).toEqual({ top: 24, right: 0, bottom: 20, left: 0 });

    const desktop = getWorkbenchDevice('desktop');
    expect(desktop.label).toBe('Desktop');
    expect(desktop.frameWidth).toBe('fluid');
    expect(desktop.frameHeight).toBe('fluid');
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
      frameWidth: 393,
      frameHeight: 852,
      stageWidth: 1400,
      stageHeight: 1100,
    });
    expect(phoneRoomy.scale).toBe(1);
    expect(phoneRoomy.fitPercent).toBe(100);
    expect(phoneRoomy.width).toBe(393);
    expect(phoneRoomy.height).toBe(852);
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
