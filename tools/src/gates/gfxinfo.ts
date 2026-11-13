/** Frame statistics from `dumpsys gfxinfo <package>`. Times are milliseconds, percentages 0 to 100. */
export interface FrameStats {
  totalFrames: number;
  /** The current janky metric (counts "frame deadline missed"). */
  jankyPercent: number;
  /** The legacy janky metric; absent on Android versions that do not print it. */
  legacyJankyPercent?: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

const number = (text: string, pattern: RegExp): number | undefined => {
  const match = pattern.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

/**
 * Parses `dumpsys gfxinfo <package>` output. Returns undefined when the output has no frame statistics or when no
 * frame was rendered: with zero frames every percentile reads as the top histogram bucket, which is not data.
 */
export function parseGfxinfo(text: string): FrameStats | undefined {
  const totalFrames = number(text, /^Total frames rendered:\s*(\d+)/m);
  const jankyPercent = number(text, /^Janky frames:\s*\d+\s*\(([\d.]+)%\)/m);
  const p50 = number(text, /^50th percentile:\s*(\d+)ms/m);
  const p90 = number(text, /^90th percentile:\s*(\d+)ms/m);
  const p95 = number(text, /^95th percentile:\s*(\d+)ms/m);
  const p99 = number(text, /^99th percentile:\s*(\d+)ms/m);
  if (
    totalFrames === undefined ||
    totalFrames === 0 ||
    jankyPercent === undefined ||
    p50 === undefined ||
    p90 === undefined ||
    p95 === undefined ||
    p99 === undefined
  ) {
    return undefined;
  }
  const legacyJankyPercent = number(text, /^Janky frames \(legacy\):\s*\d+\s*\(([\d.]+)%\)/m);
  return {
    totalFrames,
    jankyPercent,
    ...(legacyJankyPercent === undefined ? {} : { legacyJankyPercent }),
    p50,
    p90,
    p95,
    p99,
  };
}
