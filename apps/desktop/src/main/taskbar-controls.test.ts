import { describe, expect, it, vi } from 'vitest';
import {
  createTaskbarController,
  createTaskbarIconPngs,
  type TaskbarAction,
  type TaskbarIcons,
  type TaskbarWindow,
  type ThumbarButtonLike,
} from './taskbar-controls.ts';

function fakeTaskbarWindow() {
  let destroyed = false;
  const progressCalls: Array<{ progress: number; options?: { mode: string } }> = [];
  const thumbarCalls: ThumbarButtonLike<string>[][] = [];

  const win: TaskbarWindow<string> = {
    isDestroyed: () => destroyed,
    setProgressBar(progress, options) {
      progressCalls.push(options === undefined ? { progress } : { progress, options });
    },
    setThumbarButtons(buttons) {
      thumbarCalls.push([...buttons]);
      return true;
    },
  };

  return {
    win,
    progressCalls,
    thumbarCalls,
    destroy: () => {
      destroyed = true;
    },
  };
}

const ICONS: TaskbarIcons<string> = {
  previous: 'icon-prev',
  play: 'icon-play',
  pause: 'icon-pause',
  next: 'icon-next',
};

describe('createTaskbarController (#410)', () => {
  it('is a strict no-op on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const fw = fakeTaskbarWindow();
      const onAction = vi.fn();
      const ctl = createTaskbarController({
        window: fw.win,
        platform,
        icons: ICONS,
        onAction,
      });

      ctl.updatePlayback({
        active: true,
        isVod: true,
        paused: false,
        positionMs: 30_000,
        durationMs: 120_000,
        canStep: true,
      });
      ctl.clear();

      expect(fw.progressCalls).toEqual([]);
      expect(fw.thumbarCalls).toEqual([]);
      expect(onAction).not.toHaveBeenCalled();
    }
  });

  it('updates Windows VOD progress bar with 0.5% throttle, paused mode, and deduplicated thumbar buttons', () => {
    const fw = fakeTaskbarWindow();
    const actions: TaskbarAction[] = [];
    const ctl = createTaskbarController({
      window: fw.win,
      platform: 'win32',
      icons: ICONS,
      onAction: (action) => actions.push(action),
    });

    // Initial VOD playback at 25%
    ctl.updatePlayback({
      active: true,
      isVod: true,
      paused: false,
      positionMs: 25_000,
      durationMs: 100_000,
      canStep: false,
    });
    expect(fw.progressCalls).toEqual([{ progress: 0.25, options: { mode: 'normal' } }]);
    expect(fw.thumbarCalls).toHaveLength(1);
    const buttons1 = fw.thumbarCalls[0] ?? [];
    expect(buttons1.map((b) => [b.tooltip, b.icon, b.flags])).toEqual([
      ['Previous', 'icon-prev', ['disabled']],
      ['Pause', 'icon-pause', ['enabled']],
      ['Next', 'icon-next', ['disabled']],
    ]);

    // Tiny < 0.5% delta is throttled, and thumbar buttons are NOT spammed
    ctl.updatePlayback({
      active: true,
      isVod: true,
      paused: false,
      positionMs: 25_400,
      durationMs: 100_000,
      canStep: false,
    });
    expect(fw.progressCalls).toHaveLength(1);
    expect(fw.thumbarCalls).toHaveLength(1);

    // >= 0.5% progress delta updates progress bar only (thumbar unchanged)
    ctl.updatePlayback({
      active: true,
      isVod: true,
      paused: false,
      positionMs: 25_600,
      durationMs: 100_000,
      canStep: false,
    });
    expect(fw.progressCalls).toHaveLength(2);
    expect(fw.progressCalls[1]).toEqual({ progress: 0.256, options: { mode: 'normal' } });
    expect(fw.thumbarCalls).toHaveLength(1);

    // Pausing at same position immediately updates mode to 'paused' AND switches thumbar to Play
    ctl.updatePlayback({
      active: true,
      isVod: true,
      paused: true,
      positionMs: 25_600,
      durationMs: 100_000,
      canStep: false,
    });
    expect(fw.progressCalls[2]).toEqual({ progress: 0.256, options: { mode: 'paused' } });
    expect(fw.thumbarCalls).toHaveLength(2);
    const buttons2 = fw.thumbarCalls[1] ?? [];
    expect(buttons2[1]).toMatchObject({ tooltip: 'Play', icon: 'icon-play' });

    // Clicking thumbar buttons dispatches expected actions
    buttons2[0]?.click();
    buttons2[1]?.click();
    buttons2[2]?.click();
    expect(actions).toEqual(['channel-down', 'play-pause', 'channel-up']);
  });

  it('clears progress bar on Live streams, enables step buttons, and clears everything when inactive or cleared', () => {
    const fw = fakeTaskbarWindow();
    const ctl = createTaskbarController({
      window: fw.win,
      platform: 'win32',
      icons: ICONS,
      onAction: () => undefined,
    });

    ctl.updatePlayback({
      active: true,
      isVod: true,
      paused: false,
      positionMs: 500_000,
      durationMs: 100_000,
      canStep: false,
    });
    expect(fw.progressCalls.at(-1)).toEqual({ progress: 1, options: { mode: 'normal' } });

    // Switching to Live clears progress bar (-1) and enables Prev/Next
    ctl.updatePlayback({
      active: true,
      isVod: false,
      paused: false,
      positionMs: 12_000,
      durationMs: 0,
      canStep: true,
    });
    expect(fw.progressCalls.at(-1)).toEqual({ progress: -1 });
    expect(fw.thumbarCalls.at(-1)?.map((b) => b.flags)).toEqual([
      ['enabled'],
      ['enabled'],
      ['enabled'],
    ]);

    // Inactive clears both progress and thumbar buttons
    ctl.updatePlayback({
      active: false,
      isVod: false,
      paused: false,
      positionMs: 0,
      durationMs: 0,
      canStep: false,
    });
    expect(fw.thumbarCalls.at(-1)).toEqual([]);

    // Repeated clear / destroyed window are safe no-ops
    const progCount = fw.progressCalls.length;
    const thumbCount = fw.thumbarCalls.length;
    ctl.clear();
    expect(fw.progressCalls).toHaveLength(progCount);
    expect(fw.thumbarCalls).toHaveLength(thumbCount);

    fw.destroy();
    ctl.updatePlayback({
      active: true,
      isVod: true,
      paused: false,
      positionMs: 1000,
      durationMs: 2000,
      canStep: true,
    });
    ctl.clear();
    expect(fw.progressCalls).toHaveLength(progCount);
    expect(fw.thumbarCalls).toHaveLength(thumbCount);
  });
});

describe('createTaskbarIconPngs (#410)', () => {
  it('builds valid 16x16 RGBA PNG buffers in memory for previous, play, pause, and next', () => {
    const pngs = createTaskbarIconPngs();
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const key of ['previous', 'play', 'pause', 'next'] as const) {
      const buf = pngs[key];
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.subarray(0, 8).equals(signature)).toBe(true);
      expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
      expect(buf.readUInt32BE(16)).toBe(16);
      expect(buf.readUInt32BE(20)).toBe(16);
      expect(buf[24]).toBe(8);
      expect(buf[25]).toBe(6);
    }
    expect(pngs.play.equals(pngs.pause)).toBe(false);
    expect(pngs.previous.equals(pngs.next)).toBe(false);
  });
});
