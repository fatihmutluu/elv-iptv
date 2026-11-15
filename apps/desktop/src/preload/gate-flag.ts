/** The argument main adds to the preload's process in gate mode (`buildWindowOptions`). */
const GATE_ARG = '--elv-gate-mode';

/** True when main started in gate mode; only an exact argument counts. */
export function isGateMode(argv: readonly string[]): boolean {
  return argv.includes(GATE_ARG);
}
