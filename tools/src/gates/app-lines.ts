/** Handle to a spawned desktop Electron process. */
export interface AppHandle {
  readonly pid: number;
  readonly lines: AsyncIterable<string>;
  readonly exited: Promise<number | null>;
  kill(): void;
}

/**
 * Reads `lines` until `pick` returns a value. Rejects with `onTimeout()` after `timeoutMs` or when the lines end first.
 */
export async function readUntil<T>(
  lines: AsyncIterable<string>,
  pick: (line: string) => T | undefined,
  timeoutMs: number,
  onTimeout: () => Error,
  onEnd: () => Error = onTimeout,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  const scan = (async (): Promise<T> => {
    for await (const line of lines) {
      const hit = pick(line);
      if (hit !== undefined) return hit;
    }
    throw onEnd();
  })();
  try {
    return await Promise.race([scan, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits up to `graceMs` for the app to exit on its own, then kills it. */
export async function waitExit(app: AppHandle, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    app.exited.then(() => false),
    new Promise<boolean>((r) => {
      timer = setTimeout(() => r(true), graceMs);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut) app.kill();
}
