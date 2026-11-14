import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  display: { id: 2, bounds: { x: -1280, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 },
  sources: [] as Array<{ display_id: string; thumbnail: unknown }>,
  requests: [] as unknown[],
  crops: [] as unknown[],
}));

vi.mock('electron', () => ({
  screen: { getDisplayMatching: () => electron.display },
  desktopCapturer: {
    getSources: (options: unknown) => {
      electron.requests.push(options);
      return Promise.resolve(electron.sources);
    },
  },
}));

const { sampleArea } = await import('./visible.ts');

/** A thumbnail whose resized bitmap holds `colours` distinct 5-bit buckets. */
function thumbnail(size: { width: number; height: number }, colours: number) {
  const bitmap = new Uint8Array(64 * 36 * 4);
  for (let i = 0; i < 64 * 36; i += 1) bitmap[i * 4] = (i % colours) * 8;
  const image = {
    isEmpty: () => size.width === 0,
    getSize: () => size,
    crop: (rect: unknown) => {
      electron.crops.push(rect);
      return image;
    },
    resize: (opts: { width: number; height: number }) => {
      expect(opts).toMatchObject({ width: 64, height: 36 });
      return image;
    },
    toBitmap: () => Buffer.from(bitmap),
  };
  return image;
}

beforeEach(() => {
  electron.sources = [];
  electron.requests = [];
  electron.crops = [];
});

describe('sampleArea', () => {
  it('samples the display that holds the rect at physical resolution', async () => {
    electron.sources = [
      { display_id: '1', thumbnail: thumbnail({ width: 3840, height: 2160 }, 1) },
      { display_id: '2', thumbnail: thumbnail({ width: 1920, height: 1080 }, 20) },
    ];
    expect(await sampleArea({ x: -1180, y: 100, width: 640, height: 360 })).toEqual({
      distinct: 20,
    });
    expect(electron.requests).toEqual([
      { types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } },
    ]);
    expect(electron.crops).toEqual([{ x: 150, y: 150, width: 960, height: 540 }]);
  });

  it('is 0 when the capture has no image', async () => {
    expect(await sampleArea({ x: -1180, y: 100, width: 640, height: 360 })).toEqual({
      distinct: 0,
    });
    electron.sources = [{ display_id: '2', thumbnail: thumbnail({ width: 0, height: 0 }, 1) }];
    expect(await sampleArea({ x: -1180, y: 100, width: 640, height: 360 })).toEqual({
      distinct: 0,
    });
    electron.sources = [
      { display_id: '2', thumbnail: thumbnail({ width: 1920, height: 1080 }, 5) },
    ];
    expect(await sampleArea({ x: 500, y: 100, width: 64, height: 36 })).toEqual({ distinct: 0 });
  });
});
