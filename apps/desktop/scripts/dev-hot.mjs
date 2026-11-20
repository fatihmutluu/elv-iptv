import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronBinary from 'electron';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const KILL_TIMEOUT_MS = 3_000;

function parsePort(raw) {
  const trimmed = raw?.trim() || '8081';
  const port = Number(trimmed);
  if (!/^[1-9]\d{0,4}$/.test(trimmed) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    process.stderr.write(`dev:hot: invalid ELV_DEV_PORT "${trimmed}" (expected 1024..65535)\n`);
    process.exit(1);
  }
  return port;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function assertPortFree(port, host) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', (err) => {
      reject(
        new Error(
          `Port ${port} on ${host} is already in use (${err.code ?? err.message}). Stop the existing server or set ELV_DEV_PORT to a free port.`,
        ),
      );
    });
    probe.once('listening', () => {
      probe.close(() => resolve());
    });
    probe.listen(port, host);
  });
}

function killProcessTree(pid, detachedGroup = false) {
  if (pid === undefined) return Promise.resolve();
  if (isWin) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, KILL_TIMEOUT_MS);
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', finish);
      killer.on('close', finish);
    });
  }
  return (async () => {
    const target = detachedGroup ? -pid : pid;
    try {
      process.kill(target, 'SIGTERM');
    } catch {
      return;
    }
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      try {
        process.kill(target, 0);
      } catch {
        return;
      }
      await sleep(50);
    }
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // process already exited
    }
  })();
}

function spawnPnpm(args, opts) {
  if (isWin) {
    // Avoid Node 24 DEP0190 by passing a single pre-joined command string when shell: true.
    const cmdLine = ['pnpm', ...args].join(' ');
    return spawn(cmdLine, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: 'inherit',
      shell: true,
    });
  }
  return spawn('pnpm', args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: 'inherit',
    detached: opts.detached ?? false,
  });
}

function runStep(fn, label) {
  return new Promise((resolve, reject) => {
    const child = fn();
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code ?? 1}`));
    });
  });
}

async function waitForHttp200(url, isAborted) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const abortReason = isAborted();
    if (abortReason !== null) throw new Error(abortReason);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return;
    } catch {
      // Metro not ready yet
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${STARTUP_TIMEOUT_MS / 1_000}s waiting for ${url}`);
}

async function main() {
  const port = parsePort(process.env.ELV_DEV_PORT);
  const devServerOrigin = `http://127.0.0.1:${port}`;
  const baseEnv = { ...process.env, APP_VARIANT: 'development' };

  // Refuse to attach privileged Electron preload to a pre-existing unrelated server on this port.
  await assertPortFree(port, '127.0.0.1');

  await runStep(
    () => spawnPnpm(['-w', 'mpv', 'fetch'], { cwd: desktopDir, env: baseEnv }),
    'pnpm -w mpv fetch',
  );
  await runStep(
    () =>
      spawn(process.execPath, [join(desktopDir, 'scripts', 'bundle.mjs')], {
        cwd: desktopDir,
        env: baseEnv,
        stdio: 'inherit',
      }),
    'scripts/bundle.mjs',
  );

  let metroExited = null;
  let electronChild = null;
  let signalReceived = null;
  let shuttingDown = null;

  const metro = spawnPnpm(
    ['--filter', '@elv/desktop-renderer', 'exec', 'expo', 'start', '--web', '--port', String(port)],
    {
      cwd: desktopDir,
      env: { ...baseEnv, BROWSER: process.env.BROWSER ?? 'none' },
      detached: !isWin,
    },
  );

  const shutdown = (exitCode) => {
    if (shuttingDown !== null) return shuttingDown;
    shuttingDown = (async () => {
      await Promise.all([
        electronChild !== null ? killProcessTree(electronChild.pid, false) : Promise.resolve(),
        killProcessTree(metro.pid, !isWin),
      ]);
      process.exit(exitCode);
    })();
    return shuttingDown;
  };

  metro.on('error', (err) => {
    metroExited = `Metro failed to spawn: ${err.message}`;
    if (electronChild !== null) void shutdown(1);
  });
  metro.on('close', (code) => {
    metroExited = `Metro exited (code ${code ?? 1})`;
    if (electronChild !== null && shuttingDown === null) {
      process.stderr.write(`dev:hot: ${metroExited}; shutting down Electron.\n`);
      void shutdown(1);
    }
  });

  const onSignal = (sig) => {
    signalReceived = sig;
    void shutdown(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await waitForHttp200(`${devServerOrigin}/`, () => {
      if (signalReceived !== null) return `Interrupted by ${signalReceived}`;
      return metroExited;
    });
  } catch (err) {
    if (signalReceived === null) {
      process.stderr.write(`dev:hot: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    await shutdown(1);
    return;
  }

  const electronEnv = { ...baseEnv, ELV_DEV_SERVER_URL: devServerOrigin };
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  electronChild = spawn(electronBinary, ['.', ...process.argv.slice(2)], {
    cwd: desktopDir,
    env: electronEnv,
    stdio: 'inherit',
  });
  electronChild.on('error', (err) => {
    process.stderr.write(`dev:hot: Electron failed to spawn: ${err.message}\n`);
    void shutdown(1);
  });
  electronChild.on('close', (code) => {
    electronChild = null;
    void shutdown(code ?? 0);
  });
}

main().catch((err) => {
  process.stderr.write(`dev:hot: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
