import { startSim } from '../sim/server.ts';
import type { SimControl } from './import-gate.ts';

const PORT = 7878;
const PROBE_MS = 1500;

/** Whether something already answers HTTP on the simulator port. */
async function answers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(PROBE_MS) });
    return true;
  } catch {
    return false;
  }
}

/** Starts the stream simulator on 127.0.0.1:7878 in this process, or reuses one that already answers there. */
export const localSim: SimControl = {
  async ensure() {
    if (await answers(PORT)) return { reused: true, stop: async () => {} };
    const sim = await startSim({ port: PORT, host: '127.0.0.1', seed: 1 });
    return { reused: false, stop: () => sim.close() };
  },
};
