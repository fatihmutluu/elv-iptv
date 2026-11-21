import { homedir } from 'node:os';
import { join } from 'node:path';
import { createWorkbenchBridge } from './workbench-bridge.ts';

function parseBridgePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!/^\d{1,5}$/.test(trimmed) || !Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`invalid ELV_WORKBENCH_BRIDGE_PORT "${trimmed}"`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const token = process.env.ELV_WORKBENCH_BRIDGE_TOKEN?.trim() ?? '';
  if (token.length === 0) {
    throw new Error('ELV_WORKBENCH_BRIDGE_TOKEN is required');
  }
  const port = parseBridgePort(process.env.ELV_WORKBENCH_BRIDGE_PORT);
  const dataDir =
    process.env.ELV_WORKBENCH_DATA_DIR?.trim() || join(homedir(), '.elv-iptv-workbench-dev');

  const bridge = await createWorkbenchBridge({ dataDir, token, port });
  process.stdout.write(`${JSON.stringify({ ready: true, port: bridge.port, dataDir })}\n`);

  let closing = false;
  const shutdown = (code: number) => {
    if (closing) return;
    closing = true;
    void bridge.close().finally(() => {
      process.exit(code);
    });
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`workbench-bridge: ${message}\n`);
  process.exit(1);
});
