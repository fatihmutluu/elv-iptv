import type { DisplaySyncPolicy } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import {
  createDesktopDisplayRefreshController,
  type DesktopDisplayMode,
  type DesktopDisplayRefreshAdapter,
  selectDesktopRefreshMode,
} from './display-refresh.ts';

const SEAMLESS: DisplaySyncPolicy = { autoFrameRate: 'seamless', autoDynamicRange: true };
const ALWAYS: DisplaySyncPolicy = { autoFrameRate: 'always', autoDynamicRange: true };
const OFF: DisplaySyncPolicy = { autoFrameRate: 'off', autoDynamicRange: true };

const MODES_1080P: readonly DesktopDisplayMode[] = [
  { id: '720p-23976', width: 1280, height: 720, refreshRateHz: 23.976 },
  { id: '1080p-23976', width: 1920, height: 1080, refreshRateHz: 23.976 },
  { id: '1080p-24', width: 1920, height: 1080, refreshRateHz: 24 },
  { id: '1080p-50', width: 1920, height: 1080, refreshRateHz: 50 },
  { id: '1080p-5994', width: 1920, height: 1080, refreshRateHz: 59.94 },
  { id: '1080p-60', width: 1920, height: 1080, refreshRateHz: 60, isCurrent: true },
  { id: '1080p-100', width: 1920, height: 1080, refreshRateHz: 100 },
  { id: '1080p-11988', width: 1920, height: 1080, refreshRateHz: 119.88 },
  { id: '1080p-120', width: 1920, height: 1080, refreshRateHz: 120 },
];

describe('selectDesktopRefreshMode (#214, #116)', () => {
  it('returns null when autoFrameRate is off or inputs are invalid', () => {
    expect(selectDesktopRefreshMode(MODES_1080P, '1080p-60', 23.976, OFF)).toBeNull();
    expect(selectDesktopRefreshMode(MODES_1080P, 'unknown-mode', 23.976, SEAMLESS)).toBeNull();
    expect(selectDesktopRefreshMode(MODES_1080P, '1080p-60', 0, SEAMLESS)).toBeNull();
    expect(selectDesktopRefreshMode(MODES_1080P, '1080p-60', -24, SEAMLESS)).toBeNull();
    expect(selectDesktopRefreshMode(MODES_1080P, '1080p-60', Number.NaN, SEAMLESS)).toBeNull();
    expect(selectDesktopRefreshMode(MODES_1080P, '1080p-60', 300, SEAMLESS)).toBeNull();
  });

  it('prefers exact match within 0.15 Hz keeping pixel dimensions identical', () => {
    expect(selectDesktopRefreshMode(MODES_1080P, '1080p-60', 23.976, SEAMLESS)?.id).toBe(
      '1080p-23976',
    );
    expect(selectDesktopRefreshMode(MODES_1080P, '1080p-60', 24, SEAMLESS)?.id).toBe('1080p-24');
    expect(selectDesktopRefreshMode(MODES_1080P, '1080p-60', 59.94, ALWAYS)?.id).toBe('1080p-5994');
  });

  it('never picks a mode with different pixel dimensions even if it is an exact fps match', () => {
    const only720Exact: readonly DesktopDisplayMode[] = [
      { id: '720p-23976', width: 1280, height: 720, refreshRateHz: 23.976 },
      { id: '1080p-60', width: 1920, height: 1080, refreshRateHz: 60, isCurrent: true },
      { id: '1080p-11988', width: 1920, height: 1080, refreshRateHz: 119.88 },
    ];
    expect(selectDesktopRefreshMode(only720Exact, '1080p-60', 23.976, SEAMLESS)?.id).toBe(
      '1080p-11988',
    );
  });

  it('falls back to integer multiples 2x..5x when no exact match exists', () => {
    // 25 fps -> 50 Hz (2x) preferred over 100 Hz (4x)
    expect(selectDesktopRefreshMode(MODES_1080P, '1080p-60', 25, SEAMLESS)?.id).toBe('1080p-50');

    // 25 fps when only 100 Hz (4x) exists
    const modesWith100: readonly DesktopDisplayMode[] = [
      { id: '1080p-60', width: 1920, height: 1080, refreshRateHz: 60, isCurrent: true },
      { id: '1080p-100', width: 1920, height: 1080, refreshRateHz: 100 },
    ];
    expect(selectDesktopRefreshMode(modesWith100, '1080p-60', 25, SEAMLESS)?.id).toBe('1080p-100');

    // 23.976 fps -> 119.88 Hz (5x) preferred over 120 Hz
    const highRefreshOnly: readonly DesktopDisplayMode[] = [
      { id: '1080p-60', width: 1920, height: 1080, refreshRateHz: 60, isCurrent: true },
      { id: '1080p-120', width: 1920, height: 1080, refreshRateHz: 120 },
      { id: '1080p-11988', width: 1920, height: 1080, refreshRateHz: 119.88 },
    ];
    expect(selectDesktopRefreshMode(highRefreshOnly, '1080p-60', 23.976, SEAMLESS)?.id).toBe(
      '1080p-11988',
    );
  });

  it('returns null when the current mode already matches', () => {
    expect(selectDesktopRefreshMode(MODES_1080P, '1080p-60', 60, SEAMLESS)).toBeNull();
    expect(selectDesktopRefreshMode(MODES_1080P, '1080p-23976', 23.976, ALWAYS)).toBeNull();
    expect(selectDesktopRefreshMode(MODES_1080P, '1080p-50', 25, SEAMLESS)).toBeNull();
  });
});

function createFakeAdapter(initialModes: Record<string, readonly DesktopDisplayMode[]>) {
  const currentByDisplay = new Map<string, string>();
  for (const [displayId, modes] of Object.entries(initialModes)) {
    const current = modes.find((m) => m.isCurrent) ?? modes[0];
    if (current) currentByDisplay.set(displayId, current.id);
  }
  const applied: Array<{ displayId: string; modeId: string }> = [];
  const restored: Array<{ displayId: string; modeId: string }> = [];

  const adapter: DesktopDisplayRefreshAdapter = {
    listModes: vi.fn((displayId: string) => {
      const modes = initialModes[displayId] ?? [];
      const currentId = currentByDisplay.get(displayId);
      return modes.map((m) => ({ ...m, isCurrent: m.id === currentId }));
    }),
    applyMode: vi.fn((displayId: string, mode: DesktopDisplayMode) => {
      currentByDisplay.set(displayId, mode.id);
      applied.push({ displayId, modeId: mode.id });
      return true;
    }),
    restoreMode: vi.fn((displayId: string, mode: DesktopDisplayMode) => {
      currentByDisplay.set(displayId, mode.id);
      restored.push({ displayId, modeId: mode.id });
      return true;
    }),
  };

  return { adapter, applied, restored, currentId: (d: string) => currentByDisplay.get(d) };
}

describe('createDesktopDisplayRefreshController (#214, #116)', () => {
  it('uses a safe no-op fallback adapter when none is provided and never throws', () => {
    const ctl = createDesktopDisplayRefreshController();
    expect(() => {
      ctl.setPolicy('e1', SEAMLESS);
      ctl.setFullscreen('e1', true, 'display-1');
      ctl.setPlaybackActive('e1', true, 'display-1');
      ctl.setContentFps('e1', 23.976, 'display-1');
      ctl.restoreForEngine('e1');
      ctl.restoreAll();
    }).not.toThrow();
  });

  it('never switches OS refresh rate in windowed mode, and switches only when fullscreen + playing', () => {
    const fake = createFakeAdapter({ 'disp-1': MODES_1080P });
    const ctl = createDesktopDisplayRefreshController(fake.adapter);

    ctl.setPolicy('e1', ALWAYS);
    ctl.setPlaybackActive('e1', true, 'disp-1');
    ctl.setContentFps('e1', 23.976, 'disp-1');
    expect(fake.applied).toEqual([]);
    expect(fake.currentId('disp-1')).toBe('1080p-60');

    // Entering fullscreen switches immediately
    ctl.setFullscreen('e1', true, 'disp-1');
    expect(fake.applied).toEqual([{ displayId: 'disp-1', modeId: '1080p-23976' }]);
    expect(fake.currentId('disp-1')).toBe('1080p-23976');

    // Exiting fullscreen restores pre-playback mode
    ctl.setFullscreen('e1', false, 'disp-1');
    expect(fake.restored).toEqual([{ displayId: 'disp-1', modeId: '1080p-60' }]);
    expect(fake.currentId('disp-1')).toBe('1080p-60');
  });

  it('preserves original pre-playback mode across zaps and restores on stop, policy off, release, and will-quit', () => {
    const fake = createFakeAdapter({ 'disp-1': MODES_1080P });
    const ctl = createDesktopDisplayRefreshController(fake.adapter);

    ctl.setPolicy('e1', SEAMLESS);
    ctl.setFullscreen('e1', true, 'disp-1');
    ctl.setPlaybackActive('e1', true, 'disp-1');
    ctl.setContentFps('e1', 23.976, 'disp-1');
    expect(fake.currentId('disp-1')).toBe('1080p-23976');

    // Zap to 25 fps channel -> switches to 50 Hz, original 60 Hz preserved
    ctl.setContentFps('e1', 25, 'disp-1');
    expect(fake.currentId('disp-1')).toBe('1080p-50');

    // Playback stops -> restores original 60 Hz (NOT 23.976 Hz)
    ctl.setPlaybackActive('e1', false, 'disp-1');
    expect(fake.currentId('disp-1')).toBe('1080p-60');
    expect(fake.restored).toEqual([{ displayId: 'disp-1', modeId: '1080p-60' }]);

    // Restart playback at 24 fps -> switches to 24 Hz, then policy off -> restores 60 Hz
    ctl.setPlaybackActive('e1', true, 'disp-1');
    ctl.setContentFps('e1', 24, 'disp-1');
    expect(fake.currentId('disp-1')).toBe('1080p-24');
    ctl.setPolicy('e1', OFF);
    expect(fake.currentId('disp-1')).toBe('1080p-60');

    // Re-enable policy -> switches back to 24 Hz, then restoreForEngine (release / window close) -> restores 60 Hz
    ctl.setPolicy('e1', SEAMLESS);
    expect(fake.currentId('disp-1')).toBe('1080p-24');
    ctl.restoreForEngine('e1');
    expect(fake.currentId('disp-1')).toBe('1080p-60');

    // Switch again then restoreAll (app will-quit) -> restores idempotently
    ctl.setPolicy('e2', SEAMLESS);
    ctl.setFullscreen('e2', true, 'disp-1');
    ctl.setPlaybackActive('e2', true, 'disp-1');
    ctl.setContentFps('e2', 23.976, 'disp-1');
    expect(fake.currentId('disp-1')).toBe('1080p-23976');

    const restoreCountBefore = fake.restored.length;
    ctl.restoreAll();
    expect(fake.currentId('disp-1')).toBe('1080p-60');
    expect(fake.restored.length).toBe(restoreCountBefore + 1);

    // Calling restoreAll a second time is a safe idempotent no-op
    ctl.restoreAll();
    expect(fake.restored.length).toBe(restoreCountBefore + 1);
  });

  it('catches and survives adapter exceptions without throwing', () => {
    const throwingAdapter: DesktopDisplayRefreshAdapter = {
      listModes: () => {
        throw new Error('OS API unavailable');
      },
      applyMode: () => {
        throw new Error('apply failed');
      },
      restoreMode: () => {
        throw new Error('restore failed');
      },
    };
    const ctl = createDesktopDisplayRefreshController(throwingAdapter);
    expect(() => {
      ctl.setPolicy('e1', ALWAYS);
      ctl.setFullscreen('e1', true, 'disp-1');
      ctl.setPlaybackActive('e1', true, 'disp-1');
      ctl.setContentFps('e1', 23.976, 'disp-1');
      ctl.restoreAll();
    }).not.toThrow();
  });
});
