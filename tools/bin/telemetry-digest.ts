import { runTelemetryDigestCli } from '../src/telemetry-digest.ts';

const exitCode = await runTelemetryDigestCli(process.argv.slice(2));
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
