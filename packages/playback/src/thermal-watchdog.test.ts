import { describe, expect, it, vi } from 'vitest';
import {
  createThermalWatchdog,
  evaluateMultiViewThermalPolicy,
  normalizeThermalState,
  resolveHardwareMultiViewCap,
} from './thermal-watchdog';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

describe('thermal-watchdog (#232)', () => {
  describe('normalizeThermalState', () => {
    it('normalizes valid thermal states case-insensitively and falls back to nominal', () => {
      expect(normalizeThermalState('nominal')).toBe('nominal');
      expect(normalizeThermalState('FAIR')).toBe('fair');
      expect(normalizeThermalState('  Serious  ')).toBe('serious');
      expect(normalizeThermalState('critical')).toBe('critical');

      for (const unknown of ['', 'warm', 'emergency', null, undefined, 42, {}]) {
        expect(normalizeThermalState(unknown)).toBe('nominal');
      }
    });
  });

  describe('resolveHardwareMultiViewCap', () => {
    it('returns 1 when explicitly unsupported on any platform', () => {
      expect(resolveHardwareMultiViewCap({ platform: 'desktop', supported: false })).toBe(1);
      expect(
        resolveHardwareMultiViewCap({
          platform: 'android',
          totalMemoryBytes: 8 * GIB,
          supported: false,
        }),
      ).toBe(1);
    });

    it('enforces Android RAM tiers (<1.5 GiB or isLowRamDevice -> 1, <3.5 GiB -> 2, >=3.5 GiB -> 4)', () => {
      expect(resolveHardwareMultiViewCap({ platform: 'android', isLowRamDevice: true })).toBe(1);
      expect(
        resolveHardwareMultiViewCap({
          platform: 'android',
          totalMemoryBytes: 1535 * MIB,
        }),
      ).toBe(1);
      expect(
        resolveHardwareMultiViewCap({
          platform: 'android',
          totalMemoryBytes: 1536 * MIB,
        }),
      ).toBe(2);
      expect(
        resolveHardwareMultiViewCap({
          platform: 'android',
          totalMemoryBytes: 3 * GIB,
        }),
      ).toBe(2);
      expect(
        resolveHardwareMultiViewCap({
          platform: 'android',
          totalMemoryBytes: 3584 * MIB,
        }),
      ).toBe(4);
      expect(resolveHardwareMultiViewCap({ platform: 'android' })).toBe(4);
    });

    it('enforces Apple deviceModel and RAM tiers (AppleTV5,*/6,* or <3.5 GiB -> 2, else 4)', () => {
      expect(
        resolveHardwareMultiViewCap({
          platform: 'tvos',
          deviceModel: 'AppleTV5,3',
          totalMemoryBytes: 4 * GIB,
        }),
      ).toBe(2);
      expect(
        resolveHardwareMultiViewCap({
          platform: 'tvos',
          deviceModel: 'AppleTV6,2',
          totalMemoryBytes: 4 * GIB,
        }),
      ).toBe(2);
      expect(
        resolveHardwareMultiViewCap({
          platform: 'tvos',
          deviceModel: 'AppleTV11,1',
          totalMemoryBytes: 4 * GIB,
        }),
      ).toBe(4);
      expect(
        resolveHardwareMultiViewCap({
          platform: 'ios',
          totalMemoryBytes: 3 * GIB,
        }),
      ).toBe(2);
      expect(
        resolveHardwareMultiViewCap({
          platform: 'ios',
          totalMemoryBytes: 6 * GIB,
        }),
      ).toBe(4);
    });

    it('returns 4 on desktop when supported', () => {
      expect(resolveHardwareMultiViewCap({ platform: 'desktop' })).toBe(4);
    });
  });

  describe('evaluateMultiViewThermalPolicy', () => {
    it('allows adding tiles up to hardwareMaxTiles when nominal or fair', () => {
      const evalNominal = evaluateMultiViewThermalPolicy({ platform: 'desktop' }, 'nominal', 2);
      expect(evalNominal).toEqual({
        hardwareMaxTiles: 4,
        effectiveMaxTiles: 4,
        multiViewSupported: true,
        canAddTile: true,
        action: 'allow',
      });

      const evalFull = evaluateMultiViewThermalPolicy({ platform: 'desktop' }, 'fair', 4);
      expect(evalFull).toEqual({
        hardwareMaxTiles: 4,
        effectiveMaxTiles: 4,
        multiViewSupported: true,
        canAddTile: false,
        action: 'allow',
      });
    });

    it('reports low-ram or unsupported reason when hardwareMaxTiles is 1', () => {
      expect(
        evaluateMultiViewThermalPolicy({ platform: 'android', isLowRamDevice: true }, 'nominal', 0),
      ).toEqual({
        hardwareMaxTiles: 1,
        effectiveMaxTiles: 1,
        multiViewSupported: false,
        canAddTile: false,
        action: 'allow',
        reason: 'low-ram',
      });

      expect(
        evaluateMultiViewThermalPolicy({ platform: 'desktop', supported: false }, 'nominal', 0),
      ).toEqual({
        hardwareMaxTiles: 1,
        effectiveMaxTiles: 1,
        multiViewSupported: false,
        canAddTile: false,
        action: 'allow',
        reason: 'unsupported',
      });
    });

    it('warns and blocks adding new tiles on serious thermal state', () => {
      expect(evaluateMultiViewThermalPolicy({ platform: 'desktop' }, 'serious', 2)).toEqual({
        hardwareMaxTiles: 4,
        effectiveMaxTiles: 2,
        multiViewSupported: true,
        canAddTile: false,
        action: 'warn-block-add',
        reason: 'thermal-serious',
      });

      expect(evaluateMultiViewThermalPolicy({ platform: 'desktop' }, 'serious', 0)).toEqual({
        hardwareMaxTiles: 4,
        effectiveMaxTiles: 1,
        multiViewSupported: true,
        canAddTile: false,
        action: 'warn-block-add',
        reason: 'thermal-serious',
      });
    });

    it('sheds secondary tiles on critical thermal state', () => {
      expect(evaluateMultiViewThermalPolicy({ platform: 'desktop' }, 'critical', 3)).toEqual({
        hardwareMaxTiles: 4,
        effectiveMaxTiles: 1,
        multiViewSupported: true,
        canAddTile: false,
        action: 'shed-secondary',
        reason: 'thermal-critical',
      });
    });
  });

  describe('createThermalWatchdog', () => {
    it('tracks transitions, deduplicates same-state reports, normalizes unknown strings, and isolates throwing listeners', () => {
      const transitions: Array<readonly [string, string]> = [];
      const watchdog = createThermalWatchdog({
        initialState: 'fair',
        onTransition: (next, prev) => {
          transitions.push([next, prev]);
        },
      });

      expect(watchdog.getState()).toBe('fair');

      const badListener = vi.fn(() => {
        throw new Error('listener boom');
      });
      const goodListener = vi.fn();
      const unsubBad = watchdog.subscribe(badListener);
      const unsubGood = watchdog.subscribe(goodListener);

      expect(watchdog.report('fair')).toBe('fair');
      expect(transitions).toEqual([]);
      expect(goodListener).not.toHaveBeenCalled();

      expect(watchdog.report('SERIOUS')).toBe('serious');
      expect(transitions).toEqual([['serious', 'fair']]);
      expect(badListener).toHaveBeenCalledTimes(1);
      expect(goodListener).toHaveBeenCalledWith('serious', 'fair');

      // Unknown strings normalize safely to 'nominal'
      expect(watchdog.report('invalid-value')).toBe('nominal');
      expect(transitions).toEqual([
        ['serious', 'fair'],
        ['nominal', 'serious'],
      ]);

      unsubBad();
      unsubGood();
      watchdog.report('critical');
      expect(goodListener).toHaveBeenCalledTimes(2);

      watchdog.reset();
      expect(watchdog.getState()).toBe('nominal');
    });
  });
});
