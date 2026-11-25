import type { PresenterKind } from '../shared/player-ipc.ts';

/** The argument main adds to the preload's process in gate mode (`buildWindowOptions`). */
const GATE_ARG = '--elv-gate-mode';

/** Prefix of the argument main adds to the preload's process for the resolved presenter (`#34`). */
const PRESENTER_ARG_PREFIX = '--elv-presenter=';

/** True when main started in gate mode; only an exact argument counts. */
export function isGateMode(argv: readonly string[]): boolean {
  return argv.includes(GATE_ARG);
}

/** Parses the resolved desktop presenter passed from main to preload (`#34`). */
export function parsePresenterArg(argv: readonly string[]): PresenterKind | undefined {
  for (const arg of argv) {
    if (!arg.startsWith(PRESENTER_ARG_PREFIX)) continue;
    const value = arg.slice(PRESENTER_ARG_PREFIX.length);
    if (value === 'canvas' || value === 'child-window' || value === 'own-window') {
      return value;
    }
  }
  return undefined;
}
