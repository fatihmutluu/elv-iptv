import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const BRIDGE_STARTUP_TIMEOUT_MS = 15_000;
const KILL_TIMEOUT_MS = 3_000;

function parseDevPort(raw) {
  const trimmed = raw?.trim() || '8081';
  const port = Number(trimmed);
  if (!/^[1-9]\d{0,4}$/.test(trimmed) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    process.stderr.write(`dev:ui: invalid ELV_DEV_PORT "${trimmed}" (expected 1024..65535)\n`);
    process.exit(1);
  }
  return port;
}

function parseExplicitBridgePort(raw) {
  const trimmed = raw.trim();
  const port = Number(trimmed);
  if (
    !/^\d{1,5}$/.test(trimmed) ||
    !Number.isInteger(port) ||
    (port !== 0 && (port < 1024 || port > 65535))
  ) {
    process.stderr.write(
      `dev:ui: invalid ELV_WORKBENCH_BRIDGE_PORT "${trimmed}" (expected 0 or 1024..65535)\n`,
    );
    process.exit(1);
  }
  return port;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isPortFree(port, host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => {
      probe.close(() => resolve(true));
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

function waitForBridgeReady(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const succeed = (info) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(info);
    };

    const timer = setTimeout(() => {
      fail(new Error(`Timed out after ${BRIDGE_STARTUP_TIMEOUT_MS / 1_000}s starting bridge`));
    }, BRIDGE_STARTUP_TIMEOUT_MS);

    const onError = (err) => fail(new Error(`Bridge failed to spawn: ${err.message}`));
    const onClose = (code) => fail(new Error(`Bridge exited before ready (code ${code ?? 1})`));

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line);
            if (parsed && parsed.ready === true && Number.isInteger(parsed.port)) {
              succeed({ port: parsed.port, dataDir: String(parsed.dataDir ?? '') });
              return;
            }
          } catch {
            // ignore non-JSON stdout lines
          }
        }
        nl = buffer.indexOf('\n');
      }
    };

    child.stdout?.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

async function verifyBridgeHealth(baseUrl, token) {
  const res = await fetch(`${baseUrl}/health`, {
    headers: { 'X-Elv-Workbench-Token': token },
    signal: AbortSignal.timeout(3_000),
  });
  if (!res.ok) {
    throw new Error(`Bridge health check returned HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body?.ok !== true) {
    throw new Error('Bridge health check returned invalid payload');
  }
}

async function main() {
  const devPort = parseDevPort(process.env.ELV_DEV_PORT);
  const requestedBridgePort =
    process.env.ELV_WORKBENCH_BRIDGE_PORT !== undefined &&
    process.env.ELV_WORKBENCH_BRIDGE_PORT.trim() !== ''
      ? parseExplicitBridgePort(process.env.ELV_WORKBENCH_BRIDGE_PORT)
      : (await isPortFree(8082, '127.0.0.1'))
        ? 8082
        : 0;

  const bundleOut = join(desktopDir, 'dist', 'dev', 'workbench-bridge.cjs');
  await build({
    entryPoints: [join(desktopDir, 'src', 'dev', 'workbench-bridge-cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
    outfile: bundleOut,
    logLevel: 'warning',
  });

  const token = randomBytes(16).toString('hex');
  const baseEnv = { ...process.env, APP_VARIANT: 'development' };

  const bridgeChild = spawn(process.execPath, [bundleOut], {
    cwd: desktopDir,
    env: {
      ...baseEnv,
      ELV_WORKBENCH_BRIDGE_PORT: String(requestedBridgePort),
      ELV_WORKBENCH_BRIDGE_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  let expoChild = null;
  let shuttingDown = null;

  const shutdown = (exitCode) => {
    if (shuttingDown !== null) return shuttingDown;
    shuttingDown = (async () => {
      await Promise.all([
        expoChild !== null ? killProcessTree(expoChild.pid, !isWin) : Promise.resolve(),
        killProcessTree(bridgeChild.pid, false),
      ]);
      process.exit(exitCode);
    })();
    return shuttingDown;
  };

  const onSignal = (sig) => {
    void shutdown(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  let readyInfo;
  try {
    readyInfo = await waitForBridgeReady(bridgeChild);
    await verifyBridgeHealth(`http://127.0.0.1:${readyInfo.port}`, token);
  } catch (err) {
    process.stderr.write(`dev:ui: ${err instanceof Error ? err.message : String(err)}\n`);
    await shutdown(1);
    return;
  }

  const bridgeUrl = `http://127.0.0.1:${readyInfo.port}`;
  process.stdout.write(
    `dev:ui: workbench live-data bridge listening on ${bridgeUrl} (data: ${readyInfo.dataDir})\n`,
  );

  bridgeChild.on('close', (code) => {
    if (shuttingDown === null) {
      process.stderr.write(`dev:ui: bridge exited (code ${code ?? 1}); shutting down Expo.\n`);
      void shutdown(1);
    }
  });

  expoChild = spawnPnpm(
    [
      '--filter',
      '@elv/desktop-renderer',
      'exec',
      'expo',
      'start',
      '--web',
      '--port',
      String(devPort),
    ],
    {
      cwd: desktopDir,
      env: {
        ...baseEnv,
        EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_URL: bridgeUrl,
        EXPO_PUBLIC_ELV_WORKBENCH_BRIDGE_TOKEN: token,
      },
      detached: !isWin,
    },
  );

  expoChild.on('error', (err) => {
    process.stderr.write(`dev:ui: Expo failed to spawn: ${err.message}\n`);
    void shutdown(1);
  });
  expoChild.on('close', (code) => {
    expoChild = null;
    void shutdown(code ?? 0);
  });
}

main().catch((err) => {
  process.stderr.write(`dev:ui: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
