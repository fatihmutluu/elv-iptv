import { startSim } from '../sim/server.ts';
import type { SimControl } from './import-gate.ts';
import { httpSimLog } from './sim-log.ts';

const PORT = 7878;
const PROBE_MS = 1500;

/** Whether an ELV stream simulator already answers on `port` (`GET /_sim/requests` -> 200 JSON array). */
async function answers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_sim/requests`, {
      signal: AbortSignal.timeout(PROBE_MS),
    });
    if (res.status !== 200) return false;
    return Array.isArray(await res.json());
  } catch {
    return false;
  }
}

function simControlForPort(port: number): SimControl {
  const reset = () => httpSimLog(`http://127.0.0.1:${port}`).clear();
  return {
    running: () => answers(port),
    async ensure() {
      if (await answers(port)) return { reused: true, reset, stop: async () => {} };
      const sim = await startSim({ port, host: '127.0.0.1', seed: 1 });
      return { reused: false, reset, stop: () => sim.close() };
    },
  };
}

/** Starts the stream simulator on 127.0.0.1:7878 in this process, or reuses a simulator that already answers there. */
export const localSim: SimControl & { forPort(port: number): SimControl } = {
  ...simControlForPort(PORT),
  forPort: simControlForPort,
};
