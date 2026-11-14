import { desktopCapturer, type NativeImage, screen } from 'electron';
import type { Rect } from './bounds.ts';
import { countBuckets, cropInThumbnail } from './bounds.ts';

const SAMPLE = { width: 64, height: 36 };

/** Captures a screen rect (DIPs) from a desktop capture of its display at physical resolution; null without an image. */
export async function captureArea(rect: Rect): Promise<NativeImage | null> {
  const display = screen.getDisplayMatching(rect);
  const thumbnailSize = {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  const source = sources.find((s) => s.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty()) return null;
  const crop = cropInThumbnail(rect, display.bounds, source.thumbnail.getSize());
  return crop ? source.thumbnail.crop(crop) : null;
}

/**
 * Samples what the screen shows in a rect (DIPs): the capture scaled to 64x36, colours counted in 5-bit buckets.
 * A black or uniform area gives 1 or 2; video gives many; 0 means the capture returned no image.
 */
export async function sampleArea(rect: Rect): Promise<{ distinct: number }> {
  const image = await captureArea(rect);
  if (!image) return { distinct: 0 };
  return { distinct: countBuckets(image.resize({ ...SAMPLE, quality: 'good' }).toBitmap()) };
}
