import { describe, expect, it } from 'vitest';
import type { PlayerArea } from '../../../src/shared/player-ipc.ts';
import { areaHidden, createAreaSender, statusPlacement } from './area.ts';

const rect = { x: 0, y: 0, width: 800, height: 450 };

describe('createAreaSender', () => {
  it('sends nothing before the area was measured', () => {
    const sent: PlayerArea[] = [];
    createAreaSender((a) => sent.push(a)).update(undefined, false);
    expect(sent).toEqual([]);
  });

  it('sends the rounded rect as visible', () => {
    const sent: PlayerArea[] = [];
    createAreaSender((a) => sent.push(a)).update(
      { x: 0.4, y: 31.6, width: 799.5, height: 450.2 },
      false,
    );
    expect(sent).toEqual([{ x: 0, y: 32, width: 800, height: 450, visible: true }]);
  });

  it('sends an unchanged area once', () => {
    const sent: PlayerArea[] = [];
    const sender = createAreaSender((a) => sent.push(a));
    sender.update(rect, false);
    sender.update({ ...rect }, false);
    expect(sent).toHaveLength(1);
  });

  it('sends the area hidden while the player is failed, and visible again after', () => {
    const sent: PlayerArea[] = [];
    const sender = createAreaSender((a) => sent.push(a));
    sender.update(rect, false);
    sender.update(rect, true);
    sender.update(rect, false);
    expect(sent.map((a) => a.visible)).toEqual([true, false, true]);
  });

  it('is not visible when the rect is empty', () => {
    const sent: PlayerArea[] = [];
    createAreaSender((a) => sent.push(a)).update({ ...rect, height: 0 }, false);
    expect(sent[0]?.visible).toBe(false);
  });

  it('keeps the last rect when only the hidden flag arrives', () => {
    const sent: PlayerArea[] = [];
    const sender = createAreaSender((a) => sent.push(a));
    sender.update(rect, false);
    sender.update(undefined, true);
    expect(sent.at(-1)).toEqual({ ...rect, visible: false });
  });
});

describe('statusPlacement', () => {
  it('puts the status below the video when the presenter covers the area', () => {
    expect(statusPlacement(true)).toBe('below');
  });
  it('puts it inside the area otherwise, also before the presenter is known', () => {
    expect(statusPlacement(false)).toBe('inside');
    expect(statusPlacement(undefined)).toBe('inside');
  });
});

describe('areaHidden', () => {
  it('hides the video until a first frame was shown, so the idle logo never shows', () => {
    expect(areaHidden({ failed: false, framed: false })).toBe(true);
    expect(areaHidden({ failed: false, framed: true })).toBe(false);
  });
  it('hides it while failed, so the Retry card shows in the area', () => {
    expect(areaHidden({ failed: true, framed: true })).toBe(true);
  });
});
