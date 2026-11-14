import type { PlayerArea } from '../../../src/shared/player-ipc.ts';

/** A layout rectangle in CSS pixels of the window content. */
interface AreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Sends the player area to main when it changes. */
export interface AreaSender {
  /**
   * `rect` is the latest measurement (`undefined`: keep the last one); `hidden` asks for no video, as while the
   * player has failed and the Retry card must show in the area. Nothing is sent before the first measurement.
   */
  update(rect: AreaRect | undefined, hidden: boolean): void;
}

const same = (a: PlayerArea, b: PlayerArea): boolean =>
  a.x === b.x &&
  a.y === b.y &&
  a.width === b.width &&
  a.height === b.height &&
  a.visible === b.visible;

/** Creates a sender that rounds the rect to whole pixels and skips repeats. */
export function createAreaSender(send: (area: PlayerArea) => void): AreaSender {
  let rect: AreaRect | undefined;
  let last: PlayerArea | undefined;
  return {
    update(next, hidden) {
      if (next) rect = next;
      if (!rect) return;
      const x = Math.round(rect.x);
      const y = Math.round(rect.y);
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      const area: PlayerArea = { x, y, width, height, visible: !hidden && width > 0 && height > 0 };
      if (last && same(last, area)) return;
      last = area;
      send(area);
    },
  };
}

/** Where the status line goes: a video window over the area would hide it, so it moves below the area. */
export function statusPlacement(coversArea: boolean | undefined): 'below' | 'inside' {
  return coversArea === true ? 'below' : 'inside';
}
