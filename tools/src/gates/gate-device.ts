/** Target platform of a player or contract gate run. */
export type GateTarget = 'android-tv' | 'tvos' | 'ios';

/**
 * The emulator or simulator a gate run installs the development app onto, launches with a gate deep link and reads
 * logs from.
 */
export interface GateDevice {
  /** `'10.0.2.2:7878'` (Android emulator) or `'127.0.0.1:7878'` (Apple simulators). */
  readonly simHost: string;
  /** Device metadata for the baseline's `device` field. */
  describe(): Promise<Record<string, string>>;
  /** Installs the built development app onto the device. */
  install(): Promise<void>;
  /** Stops the app, optionally resets Android frame stats, runs `afterStop`, and launches it with `url`. */
  start(
    url: string,
    opts?: { resetFrames?: boolean; afterStop?: () => Promise<void> },
  ): Promise<void>;
  /** Stops the app process if it is running. */
  stop(): Promise<void>;
  /** Reads the app's log output since the last {@link start}. */
  readLog(): Promise<string>;
  /** Crash report file names written at or after `epochMs`; Android returns `[]`. */
  crashesSince(epochMs: number): Promise<string[]>;
  /** Resident memory of the running app process in megabytes, or `null` where unknown. */
  memoryMb(): Promise<number | null>;
  /** Shuts down a simulator that this runner booted; leaves an already-booted one running. */
  close(): Promise<void>;
}
