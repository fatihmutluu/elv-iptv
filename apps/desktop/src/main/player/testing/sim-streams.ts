/** Test-only constants for the local stream simulator (`pnpm sim`, seed 1, profile `small`). Apps never import `tools`. */
export const SIM_URL = process.env['ELV_SIM_URL'] ?? 'http://127.0.0.1:7878';

/** Two `demo` live channels, both recipe `h264-aac-720p25`. */
const SIM_LIVE_IDS = [1001, 1004] as const;
/** One `demo` movie, recipe `h264-aac-720p25`, container mp4. */
const SIM_MOVIE_ID = 200001;

/** A `demo` live stream URL with an optional simulator fault spec. */
export function simLiveUrl(id: number = SIM_LIVE_IDS[0], fault?: string): string {
  const query = fault === undefined ? '' : `?fault=${fault}`;
  return `${SIM_URL}/live/demo/demo/${id}.ts${query}`;
}

/** The `demo` movie URL. */
export function simMovieUrl(): string {
  return `${SIM_URL}/movie/demo/demo/${SIM_MOVIE_ID}.mp4`;
}

/** True when the simulator answers its request log. */
export async function simulatorAnswers(): Promise<boolean> {
  try {
    const res = await fetch(`${SIM_URL}/_sim/requests`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
