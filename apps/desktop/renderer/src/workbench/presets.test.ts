import { describe, expect, it } from 'vitest';
import { resolveGate } from '../gate/params.ts';
import { getWorkbenchDevice, shouldMountWorkbench, WORKBENCH_DEVICES } from './presets.ts';

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
});
